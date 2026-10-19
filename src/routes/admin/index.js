const router = require('express').Router();
const { adminAuth, requireRole } = require('../../middleware/auth');

router.use(adminAuth);
// support staff are read-only; every write needs the admin role (or super admin)
router.use((req, res, next) => (req.method === 'GET' ? next() : requireRole('admin')(req, res, next)));

router.use('/dashboard', require('./dashboard'));
router.use('/users', require('./users'));
router.use('/', require('./finance'));                       // /transactions /deposits /withdrawals /trades
router.use('/rebate-system', require('./rebate'));           // §1
router.use('/system-ranks', require('./ranks'));             // §2
router.use('/equity-bonus', require('./equity'));            // §3
router.use('/copy-trading', require('./copy'));              // §4
router.use('/pam', require('./pam'));                        // §5
router.use('/account-types', require('./accounts'));         // §6
router.use('/revenue-link', require('./revenue'));           // §7
router.use('/trading', require('./trading'));               // Alpaca orders, positions, kill switch
router.use('/templates', require('./templates'));            // §9
router.use('/audit-logs', require('./audit'));
router.use('/admins', requireRole('superadmin'), require('./admins')); // super admin only (reads too)
module.exports = router;
