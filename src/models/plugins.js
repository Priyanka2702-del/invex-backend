/** Expose `id` instead of `_id`/`__v` in JSON, and never leak secrets. */
module.exports = function jsonPlugin(schema, { hide = [] } = {}) {
  schema.set('toJSON', {
    virtuals: false,
    versionKey: false,
    transform(_doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      for (const k of hide) delete ret[k];
      return ret;
    },
  });
};
