process.on('SIGINT', () => process.exit(0));
const { Mono65 } = require('./mono65.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const m = await Mono65.open();
  for (let f = 0; f < 16; f++) {
    const r = Buffer.alloc(65);
    r[0] = 0x07;
    for (let s = 0; s < 8; s++) r[s * 8] = 0x07, r[s * 8 + 1] = 0x88;
    try { await m.dev.sendFeatureReport(r); } catch (e) { console.log(`row${f} err`, e.message.split('fail')[0]); }
    await sleep(30);
  }
  await sleep(50);
  try { await m.dev.sendFeatureReport(Buffer.from([0x07, 0xab, 0xcd, 0xef, 0x00])); } catch (e) { console.log('commit err', e.message.split('fail')[0]); }
  await sleep(200);
  try { console.log('status', JSON.stringify(await m.version()).slice(0, 60)); } catch (e) { console.log('status err', e.message.split('fail')[0]); }
  await m.close();
})().catch(e => { console.error(e.message); process.exit(1); });
