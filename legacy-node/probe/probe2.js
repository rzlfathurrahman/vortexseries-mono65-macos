#!/usr/bin/env node
// open every interface, watch input reports, then send one packet on the vendor lane
const HID = require('node-hid');
const VID = 0x1a2c, PID = 0x6180;

(async () => {
  const all = HID.devices().filter(d => d.vendorId === VID && d.productId === PID);

  const [mode] = process.argv.slice(2);
  const pkt = { '01': [0x07, 0x01, 0x00, 0x00], '76': [0x07, 0x76, 0x54, 0x32, 0x10] }[mode || 'none'];

  const handles = [];
  for (const d of all) {
    try {
      const dev = await HID.HIDAsync.open(d.path);
      dev.on('data', b => console.log(`data ${d.usagePage.toString(16)}/${d.usage.toString(16)} ${d.path.slice(-10)}`, Buffer.from(b).toString('hex').slice(0, 48)));
      handles.push(dev);
      console.log('open ok', d.usagePage.toString(16), '/', d.usage.toString(16), d.path.slice(-10));
    } catch (e) { console.log('open fail', d.usagePage.toString(16), '/', d.usage.toString(16), e.message.split('\n')[0]); }
  }

  const vendor = all.find(x => x.usagePage === 0xff00);
  if (vendor && pkt) {
    const dev = handles.find(h => h._closed !== true && h.__path === vendor.path);
    let v = null;
    try {
      const vd = await HID.HIDAsync.open(vendor.path);   // may fail if already open
      const buf = Buffer.alloc(65);
      buf[0] = 0x07;
      pkt.forEach((b, i) => buf[i + 1] = b);
      console.log('send', Buffer.from(pkt).toString('hex'));
      await vd.sendFeatureReport(buf);
    } catch (e) { console.log('vendor open/send fail:', e.message.split('\n')[0]); }
  } else if (!vendor) console.log('no vendor lane');

  console.log('--- listening 5s ---');
  await new Promise(r => setTimeout(r, 5000));
  for (const h of handles) try { await h.close(); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
