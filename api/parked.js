'use strict';
const { handle } = require('../lib/http');
const logic = require('../lib/logic');

module.exports = handle({
  POST: ({ body }) => logic.saveManual(body),   // manual spot from the web app
  PATCH: ({ body }) => logic.updateNote(body),  // edit the note
});
