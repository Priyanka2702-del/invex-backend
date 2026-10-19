const crypto = require('crypto');
/** Short readable ids, e.g. DEP-9F3A1C20BB */
const genId = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
module.exports = { genId };
