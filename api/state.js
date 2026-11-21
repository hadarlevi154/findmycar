'use strict';
const { handle } = require('../lib/http');
const logic = require('../lib/logic');

module.exports = handle({ GET: () => logic.getState() });
