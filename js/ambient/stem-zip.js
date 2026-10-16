// Streaming, uncompressed ZIP. Only the central directory is retained in memory.
const encoder = new TextEncoder();
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	let c = i;
	for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	table[i] = c >>> 0;
}
function crc32(bytes, crc) {
	for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
	return crc >>> 0;
}
function header(size) { return new DataView(new ArrayBuffer(size)); }
function u8(view) { return new Uint8Array(view.buffer); }

export async function streamZip(writable, entries) {
	let position = 0;
	const directory = [];
	async function write(bytes) { await writable.write(bytes); position += bytes.byteLength; }
	for (const { name, blob } of entries) {
		const nameBytes = encoder.encode(name);
		const start = position;
		const local = header(30);
		local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true);
		local.setUint16(6, 8, true); local.setUint16(26, nameBytes.length, true);
		await write(u8(local)); await write(nameBytes);
		let crc = 0xffffffff, size = 0;
		for await (const part of blob.stream()) {
			const bytes = part instanceof Uint8Array ? part : new Uint8Array(part);
			crc = crc32(bytes, crc); size += bytes.byteLength; await write(bytes);
		}
		crc = (crc ^ 0xffffffff) >>> 0;
		const descriptor = header(16);
		descriptor.setUint32(0, 0x08074b50, true); descriptor.setUint32(4, crc, true);
		descriptor.setUint32(8, size, true); descriptor.setUint32(12, size, true);
		await write(u8(descriptor));
		directory.push({ nameBytes, start, crc, size });
	}
	const centralStart = position;
	for (const entry of directory) {
		const v = header(46);
		v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true);
		v.setUint16(8, 8, true); v.setUint32(16, entry.crc, true);
		v.setUint32(20, entry.size, true); v.setUint32(24, entry.size, true);
		v.setUint16(28, entry.nameBytes.length, true); v.setUint32(42, entry.start, true);
		await write(u8(v)); await write(entry.nameBytes);
	}
	const end = header(22);
	end.setUint32(0, 0x06054b50, true); end.setUint16(8, directory.length, true);
	end.setUint16(10, directory.length, true); end.setUint32(12, position - centralStart, true);
	end.setUint32(16, centralStart, true); await write(u8(end));
}
