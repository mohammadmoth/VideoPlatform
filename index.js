#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { server: WebSocketServer } = require('websocket');
const { SyncRoom } = require('./lib/sync-room');
const { MediaCatalog } = require('./lib/media-catalog');

const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime' };

function parseRange(value, size) {
    if (!value) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || (!match[1] && !match[2])) return false;
    let start;
    let end;
    if (!match[1]) {
        const length = Number(match[2]);
        if (!Number.isSafeInteger(length) || length <= 0) return false;
        start = Math.max(0, size - length);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
    return { start, end: Math.min(end, size - 1) };
}

function createServer(options = {}) {
    const app = express();
    const catalog = options.catalog || new MediaCatalog({
        root: options.videosRoot,
        dataFile: options.dataFile,
        ...(options.catalogOptions || {}),
    });
    const room = new SyncRoom({ ...options, resolveMedia: id => catalog.descriptor(id) });
    const requireController = (req, res) => {
        if (room.isControllerToken(req.get('x-controller-token'))) return true;
        res.status(403).json({ error: 'The active controller is required' });
        return false;
    };

    app.get('/api/catalog', async (req, res) => {
        if (!requireController(req, res)) return;
        try {
            try { await catalog.ready; }
            catch (error) { if (!catalog.generation) throw error; }
            const sort = typeof req.query.sort === 'string' ? req.query.sort : 'name-asc';
            if (!['name-asc', 'name-desc', 'added-asc', 'added-desc'].includes(sort)) {
                return res.status(400).json({ error: 'Invalid sort mode' });
            }
            res.json(catalog.snapshot(sort));
        } catch { res.status(503).json({ error: catalog.snapshot().error || 'Catalog is unavailable' }); }
    });
    app.post('/api/catalog/refresh', async (req, res) => {
        if (!requireController(req, res)) return;
        try { res.json(await catalog.refresh({ immediate: true })); }
        catch { res.status(503).json({ error: catalog.snapshot().error || 'Catalog refresh failed' }); }
    });
    app.get('/media/:id', async (req, res) => {
        let file;
        try {
            file = await catalog.openFile(req.params.id);
            if (!file) return res.sendStatus(404);
            const range = parseRange(req.headers.range, file.size);
            if (range === false) {
                await file.handle.close();
                res.set('Content-Range', `bytes */${file.size}`);
                return res.sendStatus(416);
            }
            res.set({
                'Accept-Ranges': 'bytes',
                'Content-Type': TYPES[path.extname(file.item.relativePath).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'private, no-cache',
            });
            if (req.method === 'HEAD') {
                await file.handle.close();
                res.set('Content-Length', String(file.size));
                return res.end();
            }
            const streamOptions = { autoClose: true };
            if (range) {
                streamOptions.start = range.start;
                streamOptions.end = range.end;
                res.status(206).set({
                    'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`,
                    'Content-Length': String(range.end - range.start + 1),
                });
            } else res.set('Content-Length', String(file.size));
            file.handle.createReadStream(streamOptions).on('error', () => res.destroy()).pipe(res);
            file = null;
        } catch (error) {
            if (file?.handle) await file.handle.close().catch(() => {});
            if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return res.sendStatus(404);
            res.status(500).json({ error: 'Media could not be opened' });
        }
    });
    app.use(express.static(path.join(__dirname, 'frontend'), { index: 'index.html' }));

    const server = http.createServer(app);
    const wsServer = new WebSocketServer({
        httpServer: server,
        autoAcceptConnections: false,
        maxReceivedFrameSize: 16384,
        maxReceivedMessageSize: 16384,
        keepalive: true,
        keepaliveInterval: 10000,
        dropConnectionOnKeepaliveTimeout: true,
        keepaliveGracePeriod: 10000,
    });
    wsServer.on('request', request => {
        if (!request.requestedProtocols.includes('echo-protocol')) {
            request.reject(400, 'Unsupported protocol');
            return;
        }
        const connection = request.accept('echo-protocol', request.origin);
        const client = {
            send(message) { if (connection.connected) connection.sendUTF(JSON.stringify(message)); },
        };
        connection.on('message', message => {
            if (message.type !== 'utf8') return;
            let data;
            try { data = JSON.parse(message.utf8Data); } catch { return; }
            room.receive(client, data);
        });
        connection.on('close', () => room.leave(client));
        connection.on('error', () => connection.close());
    });
    const timer = setInterval(() => room.tick(), 1000);
    timer.unref();
    server.on('close', () => { clearInterval(timer); catalog.close(); });
    return { server, wsServer, room, catalog };
}

if (require.main === module) {
    const { server, catalog } = createServer();
    server.listen(Number(process.env.PORT) || 8080, async () => {
        console.log(`Video sync server listening on port ${server.address().port}`);
        try { await catalog.ready; console.log(`Catalog ready with ${catalog.items.size} video(s)`); }
        catch (error) { console.error(`Initial catalog scan failed: ${error.message}`); }
    });
}

module.exports = { createServer, parseRange };
