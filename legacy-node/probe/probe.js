#!/usr/bin/env node
// MONO 65 (VID 0x1A2C PID 0x6180) safety-first probe.
// Only sends packets explicitly listed in ALLOWED below — nothing free-form.
const HID = require('node-hid');

const VID = 0x1a2c, PID = 0x6180;
// [packet][tag]  tag: f = sendFeatureReport, o = write(output report)
const ALLOWED = [
  [[0x07, 0x01, 0x00, 0x00, 0x00, 0x00], 'f'],         // fw version query (read-only)
  [[0x07, 0x76, 0x54, 0x32, 0x10, 0x00], 'f'],         // init handshake
  [[0x07, 0x12, 0x34, 0x56, 0x78, 0xFE], 'f'],         // light mode fmwk (mode byte not set here)
  [[0x07, 0x23, 0x45, 0x67, 0x89, 0x00], 'f'],         // reset colors, param 0
];

const cmd = process.argv[2] ? parseInt(process.argv[2], 16) : 0x01;
const arg = process.argv[3] ? parseInt(process.argv[3], 16) : 0;   // optional 6th byte (mode/brightness)
const entry = ALLOWED.find(p => p[0][1] === cmd);
if (!entry) { console.error('cmd not in safe list'); process.exit(1); }

(async () => {
  const devices = HID.devices();
  const hit = devices.find(d => d.vendorId === VID && d.productId === PID && d.usagePage === 0xff00);
  if (!hit) { console.error('no ff00 interface'); process.exit(1); }
  console.log('open', hit.path, `up=${hit.usagePage.toString(16)} u=${hit.usage.toString(16)}`);
  const dev = await HID.HIDAsync.open(hit.path);

  const buf = Buffer.alloc(65);
  buf[0] = entry[1] === 'f' ? 0x07 : 0x00;   // report id: Windows feature reports carry 0x07
  entry[0].forEach((b, i) => buf[i + 1] = b);
  if (arg) buf[6] = arg;
  console.log('send', entry[1], buf.slice(1).toString('hex').match(/../g).slice(0,8).join(' '));

  let n;
  try {
    if (entry[1] === 'f') n = await dev.sendFeatureReport(buf);
    else n = await dev.write(buf);
  } catch (e) {
    console.error('send err', entry[1], e && e.message, e && e.stack && e.stack.split('\n')[1]);
    n = await dev.write(buf);   // fallback: plain output report
  }
  console.log('sent bytes', n);

  const replies = [];
  const sweep = [0x01, 0x07, 0x12, 0x23, 0x76, 0x88, 0x99, 0xab, 0xbb, 0xff];
  for (const id of sweep) {
    try {
      const g = await dev.getFeatureReport(id, 65);
      console.log(`getFeature${id.toString(16).padStart(2, '0')}`, Buffer.from(g).toString('hex').slice(0, 32));
    } catch (e) { console.error(`getFeature${id.toString(16).padStart(2, '0')} err`, e && e.message); }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 2000) {
    const r = await dev.read(50);
    if (r && r.length) replies.push(r);
  }
  for (let i = 0; i < 3; i++) {
    try {
      const r = await dev.read(200);
      if (!r || !r.length) break;
      replies.push(r);
    } catch (e) { console.error('read err', i, e && e.message); break; }
  }
  replies.forEach((r, i) => console.log(`reply${i}`, Buffer.from(r).slice(0,16).toString('hex').match(/../g).join(' ')));
  if (!replies.length) console.log('no reply within timeouts');
  await dev.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
