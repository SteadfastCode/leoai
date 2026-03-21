const mongoose = require('mongoose');

// Permanent cache — Bible text never changes, no TTL needed.
// Keyed by passage reference + bibleId so multiple translations coexist.
const bibleVerseSchema = new mongoose.Schema({
  bibleId:   { type: String, required: true },
  reference: { type: String, required: true }, // e.g. "John 3:16", "Psalm 23:1-3"
  passageId: { type: String, required: true }, // api.bible format e.g. "JHN.3.16"
  text:      { type: String, required: true }, // full verse/passage text
  copyright: { type: String, default: '' },
});

bibleVerseSchema.index({ bibleId: 1, passageId: 1 }, { unique: true });

module.exports = mongoose.model('BibleVerse', bibleVerseSchema);
