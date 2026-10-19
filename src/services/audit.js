const { AuditLog } = require('../models');
/** Fire-and-forget: an audit failure must never break the admin action itself. */
module.exports = function audit(admin, action, module, description = '', userId) {
  const name = typeof admin === 'string' ? admin : admin?.name || 'system';
  return AuditLog.create({ admin: name, action, module, description, userId }).catch((e) => console.error('audit failed', e.message));
};
