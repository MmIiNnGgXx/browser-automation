// Minimal RFC6455 WebSocket client for Chrome DevTools Protocol (CDP).
//
// Why: Node's built-in (undici) WebSocket connects to CDP but closes with 1006
// the moment a frame is sent (undici advertises permessage-deflate the CDP
// server rejects). This hand-rolled client sends masked frames with no
// extensions and no compression — exactly what CDP wants — and depends only on
// node:http / node:crypto / node:events. It targets the single-use CDP
// `ws://host:port/devtools/page/<id>` endpoint.

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class CdpWebSocket extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.url = new URL(wsUrl);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.readyState = 0; // 0 connecting, 1 open, 2 closing, 3 closed
    this.fragments = [];
    this.fragmentOpcode = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        hostname: this.url.hostname,
        port: this.url.port || 80,
        path: this.url.pathname + this.url.search,
        headers: {
          Host: `${this.url.hostname}:${this.url.port || 80}`,
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });

      req.on('upgrade', (res, socket, head) => {
        if (res.statusCode !== 101) { reject(new Error(`WebSocket upgrade failed: ${res.statusCode}`)); socket.destroy(); return; }
        // verify Sec-WebSocket-Accept
        const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== expected) {
          reject(new Error('WebSocket accept key mismatch')); socket.destroy(); return;
        }
        this.socket = socket;
        this.readyState = 1;
        if (head && head.length) this.buffer = Buffer.concat([head, this.buffer]);
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => this._onClose());
        socket.on('error', (e) => this.emit('error', e));
        this.emit('open');
        resolve();
      });

      req.on('error', reject);
      req.end();
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _parseFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); offset = 10; }
    let maskKey = null;
    if (masked) { if (b.length < offset + 4) return null; maskKey = b.subarray(offset, offset + 4); offset += 4; }
    if (b.length < offset + len) return null;
    let payload = b.subarray(offset, offset + len);
    if (masked && maskKey) {
      const unm = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unm[i] = payload[i] ^ maskKey[i % 4];
      payload = unm;
    }
    this.buffer = b.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) { // close
      try { this._sendFrame(0x8, payload.subarray(0, 2)); } catch {}
      this.readyState = 3;
      this.emit('close', { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1006, reason: payload.length > 2 ? payload.subarray(2).toString() : '' });
      this._destroySocket();
      return;
    }
    if (opcode === 0x9) { // ping -> pong
      this._sendFrame(0xA, payload);
      return;
    }
    if (opcode === 0xA) return; // pong

    if (opcode === 0x0) { // continuation
      this.fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        this._emitData(this.fragmentOpcode, full);
      }
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) { // text / binary start
      this.fragmentOpcode = opcode;
      if (fin) this._emitData(opcode, payload);
      else this.fragments = [payload];
      return;
    }
  }

  _emitData(opcode, payload) {
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('message', payload);
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) throw new Error('socket not open');
    const mask = crypto.randomBytes(4);
    const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    let header;
    const len = payloadBuf.length;
    if (len < 126) { header = Buffer.from([0x80 | opcode, 0x80 | len]); }
    else if (len < 65536) {
      header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payloadBuf[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(data) { this._sendFrame(0x1, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')); }

  close() {
    this.readyState = 2;
    try { this._sendFrame(0x8, Buffer.from([0x03, 0xe8])); } catch {}
    this._destroySocket();
  }

  _onClose() {
    if (this.readyState === 1) { this.readyState = 3; this.emit('close', { code: 1006, reason: '' }); }
    else if (this.readyState !== 3) { this.readyState = 3; this.emit('close', { code: 1006, reason: '' }); }
  }

  _destroySocket() { try { if (this.socket) this.socket.destroy(); } catch {} }
}
