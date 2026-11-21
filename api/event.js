'use strict';
// Called by the iPhone Shortcuts automations (car connects / disconnects).
const { handle } = require('../lib/http');
const logic = require('../lib/logic');

module.exports = handle({ POST: ({ body }) => logic.applyEvent(body) });
