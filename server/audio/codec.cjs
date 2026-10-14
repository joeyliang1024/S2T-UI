const encode = value => ArrayBuffer.isView(value) && !Buffer.isBuffer(value) ? Array.from(value) : Buffer.isBuffer(value) ? { __s2tBuffer: value.toString('base64') } : Array.isArray(value) ? value.map(encode) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) : value
const decode = value => value && typeof value.__s2tBuffer === 'string' ? Buffer.from(value.__s2tBuffer, 'base64') : Array.isArray(value) ? value.map(decode) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)])) : value

module.exports = { encode, decode }
