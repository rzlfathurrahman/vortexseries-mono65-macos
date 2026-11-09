#!/usr/bin/env node
// MONO 65 (VortexSeries) driver for macOS — node-hid feature transport.
// Protocol derived from DeviceDriver.exe reverse engineering (see protocol.md).
const HID = require('node-hid');
const VID = 0x1a2c, PID = 0x6180;

const hex = b => Buffer.from(b).toString('hex').match(/../g).join(' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// feature SET, single shot (retries would re-transmit a consumed frame — duplicate
// rows confuse the device's staging); macOS 0xE00002D6 on structural frames means
// the device took it and holds the lane, log and continue the flow
const sendLM = async (dev, frame) => {
  try { await dev.sendFeatureReport(frame); }
  catch (e) { return e.message.split(': ').pop(); }
};
// 64-byte total: Windows driver passes BufferLength 0x40 to HidD_SetFeature —
// report id + 63 payload, byte 64 is never on the wire
const mk = (id, ...payload) => { const b = Buffer.alloc(64); b[0] = id; b.set(payload, 1); return b; };

class Mono65 {
  constructor(dev) { this.dev = dev; }

  static async open() {
    const d = HID.devices().find(x => x.vendorId === VID && x.productId === PID && x.usagePage === 0xff00);
    if (!d) throw new Error('no vendor lane (ff00) found');
    return new Mono65(await HID.HIDAsync.open(d.path));
  }

  // temporary recovery: flush a wedged macro-open (16 zero rows + commit EF)
  async unstall() {
    for (let f = 0; f < 16; f++) {
      const r = Buffer.alloc(64);
      r[0] = 0x07;
      for (let s = 0; s < 8; s++) r[s * 8] = 0x07, r[s * 8 + 1] = 0x88;
      await this.dev.sendFeatureReport(r);
      await sleep(60);
    }
    await sleep(150);
    await this.dev.sendFeatureReport(mk(0x07, 0xab, 0xcd, 0xef, 0x00));
    await sleep(250);
  }

  // HidD_SetFeature lane: [07][cmd][args ..][pad 0]
  async set(...payload) {
    await sendLM(this.dev, mk(0x07, ...payload));
    await sleep(120);                      // driver uses Sleep(0x20)+ buffer
    let last;
    for (let i = 3; i > 0; i--) {
      try { return await this.read(); }
      catch (e) { last = e.message.split(': ').pop(); await sleep(60); }
    }
    return { err: last };
  }

  // DeviceIoControl read path (state reply register)
  async read() { return Buffer.from(await this.dev.getFeatureReport(0x07, 64)); }

  async version() {
    await this.dev.sendFeatureReport(mk(0x07, 0x01, 0x00));
    await sleep(120);
    let g = await this.read();
    if (g[0] !== 0x07) return { raw: hex(g) };
    return { raw: hex(g), value: g[1] | g[2] << 8, idle: [g[1], g[2]].join(' ') };
  }

  async handshake()  // REMOVED: bare handshake locks the device. Part of remap() only.
  { throw new Error('bare handshake wedges device; use remap() full flow'); }

  // preset frame (FUN_0041afb0/a5f0): mode 1-8, speed 1-4, brightness 1-4.
  // High-bar (>=200 lightId) routes the same payload to the WriteFile lane instead.
  async preset(mode = 1, speed = 2, brightness = 4) {
    return this.set(0xff, 0xff, (mode - 1) & 0xff, speed & 0xff, brightness & 0xff, 0x00, 0x00);
  }

  // full driver remap flow (FUN_004111a0): macro relay -> remap open `07 76 54 32 10 00`
  // -> rows packet -> commit `07 FE DC BA`. Up to 12 pairs (staging limit: srcs take
  // staging bytes 0..11, dsts bytes 12..23). Pack: src k -> stage k, dst k -> stage
  // 12+k; stage bytes copy consecutively into the marker windows (start f2/10/18/26).
  // BARE open frames lock the device.
  // Driver interframes ~50/100 ms (Sleep(0x20) on lanes); we pace wider live.
  async remap(pairs) {
    if (!Array.isArray(pairs)) throw new Error('pairs = [[src,dst], ...]');
    if (pairs.length > 12) throw new Error('max 12 remap pairs; staging takes 12');
    const errs = [];
    // 1. macro/keybind relay (FUN_0041c7b0): open + 16 empty `07 88` rows + commit `07 AB CD EF`
    let e = await sendLM(this.dev, mk(0x07, 0x01, 0x23, 0x45, 0x67, 0x00));
    if (e) errs.push(`macro-open: ${e}`);
    await sleep(300);
    for (let f = 0; f < 16; f++) {
      const r = Buffer.alloc(64);
      r[0] = 0x07;
      for (let s = 0; s < 8; s++) r[s * 8] = 0x07, r[s * 8 + 1] = 0x88;
      e = await sendLM(this.dev, r);
      if (e) errs.push(`mrow${f}: ${e}`);
      await sleep(250);
    }
    await sleep(300);
    e = await sendLM(this.dev, mk(0x07, 0xab, 0xcd, 0xef, 0x00));
    if (e) errs.push(`mcommit: ${e}`);
    await sleep(300);
    // 2. remap mode open (byte 4 = 0x10, then 0)
    e = await sendLM(this.dev, mk(0x07, 0x76, 0x54, 0x32, 0x10, 0x00));
    if (e) errs.push(`remap-open: ${e}`);
    await sleep(300);
    // 3. rows: src array in window0+window1, dst array in window2+window3 (staging k / k+12)
    // stage byte s -> frame byte: {0..5: 2+s} {6..11: 10+s-6} {12..17: 18+s-12} {18..23: 26+s-18}
    const p = Buffer.alloc(64);
    p[0] = 0x07;
    for (let row = 0; row < 8; row++) p[row * 8] = 0x07, p[row * 8 + 1] = 0x99;
    const stgF = s => (s < 6 ? 2 + s : s < 12 ? 4 + s : s < 18 ? 6 + s : 8 + s);
    for (let i = 0; i < pairs.length; i++) {
      p[stgF(i)] = pairs[i][0] & 0xff;
      p[stgF(12 + i)] = pairs[i][1] & 0xff;
    }
    e = await sendLM(this.dev, p);
    if (e) errs.push(`rows: ${e}`);
    await sleep(300);
    // 4. commit/flash means the table replaces the whole stored set — caller supplies all pairs
    e = await sendLM(this.dev, mk(0x07, 0xfe, 0xdc, 0xba, 0x00));
    if (e) errs.push(`rcommit: ${e}`);
    await sleep(300);
    if (errs.length) return { err: errs };
    return { ok: true };
  }

  async close() { await this.dev.close(); }
}

module.exports = { Mono65, hex, mk };
