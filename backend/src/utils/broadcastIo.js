/**
 * Creates an io proxy that emits to the target room as usual, but also
 * re-broadcasts to the 'superadmin' room with `domain` added to the payload.
 * This lets the scraper stay domain-agnostic while superadmins see all crawls.
 */
function makeBroadcastIo(io, domain) {
  return {
    to(room) {
      const target = io.to(room);
      return {
        emit(event, data) {
          target.emit(event, data);
          // Exclude sockets already in the domain room — superadmins watching a specific
          // entity's crawl would otherwise receive every event twice.
          io.to('superadmin').except(room).emit(event, { ...data, domain });
        },
      };
    },
  };
}

module.exports = { makeBroadcastIo };
