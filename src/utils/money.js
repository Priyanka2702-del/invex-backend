const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
module.exports = { round2 };
