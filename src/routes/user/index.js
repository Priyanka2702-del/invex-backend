const router = require('express').Router();
router.use('/auth', require('./auth'));
router.use('/me', require('./me'));
router.use('/market', require('./market'));
router.use('/public', require('./public'));
module.exports = router;
