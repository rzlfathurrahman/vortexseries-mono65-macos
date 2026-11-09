# MONO 65 (VortexSeries) USB protocol

Source: `DeviceDriver.exe` (sha256 `8dda1f99...`) decompiled via Ghidra 12.1.4.
Addresses refer to that binary. All packets are 64-byte HID **feature reports**;
the first byte is report id. Traffic observed in the app is send-first; the only
read path is FUN_00432a90 (state query).

## Transports in DeviceDriver.exe

| fn | syscall | frame |
|---|---|---|
| FUN_004327a0 → FUN_00433e30 | `HidD_SetFeature(h, buf, 0x40)` | 64 B, `[0x07][cmd][args][pad 0]`, Sleep(0x20) before send |
| FUN_00432870 → FUN_00433d50 | `WriteFile(h, buf, 0x41)` + GetOverlappedResult | 65 B, `[0x00][64 B same as above]`, retry once if result <1 |
| FUN_00433ed0 | `DeviceIoControl(h, 0xB0192, buf, 0x40, buf, 0x40)` | 64 B feature report in/out — used by the read path |
| FUN_00433bb0 | `CreateFileA(path, 0xC0000000, 3, …, 3, 0x40000000)` | write+overlapped handle per HID interface |
| FUN_00433780 | SetupDi enumeration | HID GUID `{4D1E55B2-F16F-11CF-88CB-001111000030}` |

Device handle object: `[0] handle, [4] busy flag, [8..0xC] device vector, [0x14] error msg`.

## Frame inventory (report id 0x07 unless noted)

Static magic runs decoded from packet builders:

- `07 76 54 32 10 00...` — **remap-mode open** (FUN_004111a0; byte 4 = 0x10, byte 5 = 0).
  Opens the device's remap-table reception window; must be followed IMMEDIATELY by
  the row packet + commit or GET/SET fail with macOS `0xE0005000` / `0xE00002D6`
  until replug (locked twice live 2026-11-09; a bare rows+commit unwedge worked
  only once). Ever send only inside remap().
- **macOS live-note:** single-shot `sendFeatureReport` intermittently throws
  `IOHIDDeviceSetReport failed: (0xE00002D6) I/O Timeout` on structural frames
  (macro-open `07 01 23 45 67`, remap-open) even when the device consumed the
  frame — it then holds the lane waiting for the rest of that flow. Never abort
  mid-flow; retry the frame (mono65.js `sendLM`) and keep sending. Two live
  lockouts 2026-11-09 came from aborting after a timeout, not from frame content.
  Emergency recovery for a macro-open wedge: 16 zero `07 88` rows + `07 AB CD EF`
  (`unstall()` / unstall.js). If the keyboard disappears from HID enumeration
  entirely, its controller hard-hung — replug USB.
- `07 01 00 00...` — FUN_00432a90: **read state / firmware version**. Query buffer is
  `[07 01 xx]` zero-filled, sent through ioctl 0xB0192 (in/out same buffer), retry
  once if reply byte0 ≠ 0x07; reply bytes[1..2] are a uint16 printed as the
  firmware version (FUN_00420cd0).
- `07 FF FF <mode-1> <speed> <brightness> 00 ...` — FUN_0041afb0/0041a5f0 (UI task
  7): **set preset light mode**. Hardware-verified 2026-11-09: mode-1 = 0..18 for
  modes 1..19 (layout KB-K102), speed 1..4, brightness 1..4 all visible. Mode >=
  200 routes the same payload through the WriteFile lane (FUN_00432870) instead.
  `07 F0 AA 00...` (FUN_004209b0, task 0xa) plus Sleep(100) re-applies current
  light data; `07 12 34 56 78 FE mm` was earlier misattributed to mode — the
  `12 34 56 78` header is the per-key custom-layer frame family (below).
- `07 12 34 56 78 FE ee 00 cc...` — FUN_0041b1d0: enable/disable the custom layer
  toggle (`ee` = `00`/`FE`), then re-send with combo index.
- `07 12 34 56 78 FE <key> <on>` — FUN_0041aa10: per-key light-layer color enable.
- `07 01 23 45 67 00 00...` — FUN_0041c7b0: macro/keybind upload open.
- macro chunks — same fn: a 0x4B0 buffer split into 64-byte feature writes whose
  rows carry `07 88` markers every 8 bytes; row layout (per SourceRef pseudo-code):
  `+1=0, +2=keycode, +3=count(1..255), +4..=sequence`; content from
  FUN_0041c2b0 (timing strings) / FUN_0041c430 (app/URL open).
- `07 AB CD EF 00...` — same fn: macro upload close/commit.
- **remap row packet** (FUN_004111a0, sent inside remap-mode open): one 64-byte
  feature write. `07 99` word markers at offsets 0,8,16,24,32,40,48,56; the 6 bytes
  between each marker are copied in order from driver staging bytes (stage s0..s47 →
  frame windows 2..7,10..15,18..23,26..31,34..39,42..47,50..55,58..63). Staging holds
  a parallel-array pair set built from `t_key_macro_data` (single-key remaps
  `macro_type` ∉ {0,3,7}): src Δ=slot k = `key_code` at stage k, dst Δ=slot k =
  `macro_value` at stage 12+k. So src array = windows 0+1, dst array = windows 2+3,
  pairs match by index — max 12 slots. Single remap Home→`~`: f2=0x4a, f18=0x35,
  everything else 0 apart from the markers.
  Then commit `07 FE DC BA 00...`. Table replaces the whole stored set; pad unused
  slots with 0.
- `07 23 45 67 89 xx bb 00...` — FUN_0041a790: reset colors, `bb` = value param
  (LE dword `0x67452307` + `0x89` byte). Never produced visible change alone;
  superseded by the preset frame for brightness.
- `07 AA BB CC ...` — not yet decoded.

Large-transfer variant FUN_004209b0 sends a packet starting `0xBB` (`0x8899AABB`
dword → bytes `BB AA 99 88`) through the WriteFile transport when mode >= 200. Not
decoded yet; assumed to be the bulk-download protocol, distinct report id.

## macOS plan

Use node-hid with `VID 0x1A2C PID 0x6180`, usagePage 0xFF00. Send feature reports
`[07 …]` with `writeFeature`-style API; probe safely with no-effect candidates
first (`07 01` read-query is read-only).
