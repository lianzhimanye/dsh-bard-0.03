// Minimal ASAR reader: list / read one file / extract all.
// Usage:
//   node asar-extract.mjs list  <archive> [prefix]
//   node asar-extract.mjs read  <archive> <innerPath>
//   node asar-extract.mjs extract <archive> <outDir> [prefix]
import fs from 'node:fs'
import path from 'node:path'

const [cmd, archive, arg2, arg3] = process.argv.slice(2)
if (!cmd || !archive) {
  console.error('usage: asar-extract.mjs <list|read|extract> <archive> [arg] [prefix]')
  process.exit(2)
}

// ASAR layout:
//   [u32 sizePicklePayload=4][u32 headerBufLen]
//   then headerBuf: [u32 payloadLen][u32 jsonLen][json...][pad4]
//   then file data at 8 + headerBufLen
const fd = fs.openSync(archive, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerBufLen = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const headerJson = Buffer.alloc(jsonLen)
fs.readSync(fd, headerJson, 0, jsonLen, 16)
const header = JSON.parse(headerJson.toString('utf8'))
const dataOffset = 8 + headerBufLen

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, p, out)
    else out.push({ path: p, size: value.size, offset: value.unpacked ? NaN : value.offset, unpacked: !!value.unpacked })
  }
}

const all = []
walk(header, '', all)
const listAll = () => all

if (cmd === 'list') {
  const filter = arg2 || ''
  for (const f of listAll()) {
    if (!filter || f.path.startsWith(filter)) console.log(f.size + '\t' + f.path)
  }
} else if (cmd === 'read') {
  const target = listAll().find(f => f.path === arg2)
  if (!target) {
    console.error('not found: ' + arg2)
    process.exit(1)
  }
  const buf = Buffer.alloc(target.size)
  fs.readSync(fd, buf, 0, target.size, dataOffset + Number(target.offset))
  process.stdout.write(buf)
} else if (cmd === 'extract') {
  const outDir = arg2
  const prefix = arg3 || ''
  let n = 0
  for (const f of listAll()) {
    if (prefix && !f.path.startsWith(prefix)) continue
    if (f.unpacked) continue
    if (!Number.isInteger(Number(f.offset))) continue
    const dest = path.join(outDir, f.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const buf = Buffer.alloc(f.size)
    fs.readSync(fd, buf, 0, f.size, dataOffset + Number(f.offset))
    fs.writeFileSync(dest, buf)
    n++
  }
  console.error(`extracted ${n} files to ${outDir}`)
} else {
  console.error('unknown command ' + cmd)
  process.exit(2)
}
