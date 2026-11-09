#!/usr/bin/env node
// mono65ctl — command line for the MONO 65 on macOS
// usage:
//   node mono65ctl.js status            read firmware/state probe
//   node mono65ctl.js preset <mode> [speed] [brightness]   mode 1-8, speed/brightness 1-4 (def 2,4)
//   node mono65ctl.js remap <src> <dst> remap one key (key codes 0..255)
const args = process.argv.slice(2);
const run = args[0], a1 = args[1] !== undefined ? parseInt(args[1], 0) : undefined;
const a2 = args[2] !== undefined ? parseInt(args[2], 0) : undefined;

/* eslint-disable no-template-curly-in-string */
const { Mono65, hex } = require('./mono65.js');

(async () => {
  const m = await Mono65.open();
  try {
    switch (run) {
      case 'status': console.log(JSON.stringify(await m.version())); break;
      case 'preset': await m.preset(a1, a2 || 2, args[3] ? parseInt(args[3], 0) : 4); console.log(`preset ${a1} speed ${a2 || 2} brightness ${args[3] || 4} sent`); break;
      case 'remap':  { const r = await m.remap([[a1, a2]]); console.log(r && r.err ? `err ${JSON.stringify(r.err)}` : 'remap sent'); break; }
      default: console.error('unknown command'); process.exit(1);
    }
  } finally { await m.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
