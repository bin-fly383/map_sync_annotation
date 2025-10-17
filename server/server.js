// server.js
// Node.js Express + Redis persistence + optional broadcast to Lightcable
// Usage: npm install express cors redis ws morgan
'use strict';

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createClient } = require('redis');
const WebSocket = require('ws');

const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*' // 可按需限制
}));
app.use(express.json({ limit: '64kb' }));
app.use(morgan('tiny'));

// 配置（可通过环境变量覆盖）
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const LIGHTCABLE_WS_URL = process.env.LIGHTCABLE_WS_URL || null; // e.g. 'ws://localhost:8088/402'
const API_KEY = process.env.API_KEY || null; // 如果设置了，则启用简单校验：请求头 x-api-key: <API_KEY>
const REDIS_ANNOTATIONS_KEY = process.env.REDIS_ANNOTATIONS_KEY || 'annotations_hash';

// Redis 客户端
const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('Redis error', err));

// 可选：连接到 Lightcable 用于广播（服务端作为客户端向 Lightcable 发送广播消息）
let lcws = null;
function connectLightcable() {
  if (!LIGHTCABLE_WS_URL) return;
  lcws = new WebSocket(LIGHTCABLE_WS_URL);
  lcws.on('open', () => console.log('Connected to Lightcable at', LIGHTCABLE_WS_URL));
  lcws.on('close', () => {
    console.warn('Lightcable WS closed, will attempt reconnect in 2s');
    lcws = null;
    setTimeout(connectLightcable, 2000);
  });
  lcws.on('error', (e) => {
    console.error('Lightcable WS error', e.message || e);
  });
}
if (LIGHTCABLE_WS_URL) connectLightcable();

function broadcastToLightcable(obj) {
  if (lcws && lcws.readyState === WebSocket.OPEN) {
    try { lcws.send(JSON.stringify(obj)); } catch (e) { console.warn('LC send err', e); }
  } else {
    // 如果你希望更可靠，可以在此处做消息队列或重试
    console.warn('Lightcable not connected; skip broadcast', obj);
  }
}

// 简单 API Key 中间件（如果 API_KEY 未设置则跳过验证）
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.header('x-api-key') || req.query.api_key;
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// 连接 Redis 然后启动服务器
(async () => {
  await redis.connect();
  console.log('Connected to Redis at', REDIS_URL);

  // GET /annotations -> 返回 array [{id, lngLat, updatedAt}]
  app.get('/annotations', requireApiKey, async (req, res) => {
    try {
      const all = await redis.hGetAll(REDIS_ANNOTATIONS_KEY); // returns object id->jsonStr
      const list = Object.keys(all).map(id => {
        try {
          const obj = JSON.parse(all[id]);
          return { id, ...obj };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      res.json(list);
    } catch (e) {
      console.error('GET /annotations err', e);
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST /annotations  -> 创建或覆盖（upsert）
  // body: { id, lngLat: [lng, lat], clientId? }
  app.post('/annotations', requireApiKey, async (req, res) => {
    try {
      const { id, lngLat, clientId } = req.body;
      if (!id || !Array.isArray(lngLat) || lngLat.length < 2) {
        return res.status(400).json({ error: 'invalid payload, need id and lngLat' });
      }
      const obj = { lngLat, updatedAt: Date.now(), clientId: clientId || null };
      await redis.hSet(REDIS_ANNOTATIONS_KEY, id, JSON.stringify(obj));
      // 广播给 lightcable（如果连接）
      broadcastToLightcable({ type: 'add', id, lngLat, clientId: clientId || null });
      res.status(201).json({ id, ...obj });
    } catch (e) {
      console.error('POST /annotations err', e);
      res.status(500).json({ error: 'internal' });
    }
  });

  // PUT /annotations/:id -> 更新（body: { lngLat, clientId? })
  app.put('/annotations/:id', requireApiKey, async (req, res) => {
    try {
      const id = req.params.id;
      const { lngLat, clientId } = req.body;
      if (!Array.isArray(lngLat) || lngLat.length < 2) {
        return res.status(400).json({ error: 'invalid payload, need lngLat' });
      }
      const existingRaw = await redis.hGet(REDIS_ANNOTATIONS_KEY, id);
      const obj = { lngLat, updatedAt: Date.now(), clientId: clientId || null };
      await redis.hSet(REDIS_ANNOTATIONS_KEY, id, JSON.stringify(obj));
      broadcastToLightcable({ type: 'update', id, lngLat, clientId: clientId || null });
      res.json({ id, ...obj, existed: !!existingRaw });
    } catch (e) {
      console.error('PUT /annotations/:id err', e);
      res.status(500).json({ error: 'internal' });
    }
  });

  // DELETE /annotations/:id
  app.delete('/annotations/:id', requireApiKey, async (req, res) => {
    try {
      const id = req.params.id;
      const removed = await redis.hDel(REDIS_ANNOTATIONS_KEY, id);
      broadcastToLightcable({ type: 'remove', id, clientId: null });
      res.json({ id, removed: removed > 0 });
    } catch (e) {
      console.error('DELETE /annotations/:id err', e);
      res.status(500).json({ error: 'internal' });
    }
  });

  // health
  app.get('/health', (req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`State server listening on http://0.0.0.0:${PORT} (with Redis persistence)`);
  });
})();
