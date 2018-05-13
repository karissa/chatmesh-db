var hyperdb = require('hyperdb')
var strftime = require('strftime')
var events = require('events')
var encoding = require('dat-encoding')
var inherits = require('inherits')

module.exports = Mesh

/**
 * Create a new Chatmesh. This is the object handling all
 * local nickname -> mesh interactions for a single user.
 * @constructor
 * @param {string|function} storage - A hyperdb compatible storage function, or a string representing the local data path.
 * @param {string} href - The dat link
 * @param {Object} opts - Options include: username
 */
function Mesh (storage, href, opts) {
  if (!(this instanceof Mesh)) return new Mesh(storage, href, opts)
  if (!opts) opts = {}
  events.EventEmitter.call(this)
  var self = this

  var json = {
    encode: function (obj) {
      return Buffer.from(JSON.stringify(obj))
    },
    decode: function (buf) {
      var str = buf.toString('utf8')
      try { var obj = JSON.parse(str) }
      catch (err) { return {} }
      return obj
    }
  }

  self.username = opts.username || 'anonymous'

  try {
    var key = encoding.decode(href)
    self.addr = encoding.encode(key)
  } catch (e) {
    self.addr = null
  }
  self.db = self.addr
    ? hyperdb(storage, self.addr, {valueEncoding: json})
    : hyperdb(storage, {valueEncoding: json})

  self.channels = {}
  self.users = {}
  self.users[opts.username] = new Date()
}

inherits(Mesh, events.EventEmitter)

/**
 * When a connection is made. Auto-authorizes new peers to
 * write to the local database. Maintains the local view
 * of visible users.
 * @param {Object} peer - The discovery-swarm peer emitted from the 'connection' or 'disconnection' event
 */
Mesh.prototype.onconnection = function (peer) {
  var self = this
  if (!peer.remoteUserData) return
  try { var data = JSON.parse(peer.remoteUserData) }
  catch (err) { return }
  var key = Buffer.from(data.key)
  var username = data.username

  self.db.authorized(key, function (err, auth) {
    if (err) return console.log(err)
    if (!auth) self.db.authorize(key, function (err) {
      if (err) return console.log(err)
    })
  })

  if (!self.users[username]) {
    self.users[username] = new Date()
    self.emit('join', username)
    peer.on('close', function () {
      if (!self.users[username]) return
      delete self.users[username]
      self.emit('leave', username)
    })
  }
}

/**
 * Join a channel.
 * @param {String} channel - The channel to join.
 */
Mesh.prototype.joinChannel = function (channel) {
  this.channels[channel] = true
}

/**
 * Leave a channel.
 * @param {String} channel - The channel to leave.
 */
Mesh.prototype.leaveChannel = function (channel) {
  delete this.channels[channel]
}

/**
 * Create a readable stream for the mesh.
 * @param {String} channel - The channel you want to read from.
 */
Mesh.prototype.createReadStream = function (channel, opts) {
  if (!opts) opts = {}
  return this.db.createReadStream(`${channel}`, Object.assign({recursive: true}, opts))
}


/**
 * Create a message.
 * @param {String} channel - The channel to create the message.
 * @param {String} message - The message to write.
 * @param {Object} opts - Options: date, username
 * @param {function} done - When message has been successfully added.
 */
Mesh.prototype.message = function (channel, message, opts, done) {
  if (typeof opts === 'function') return this.message(channel, message, null, opts)
  if (!opts) opts = {}
  var self = this
  if (!message) return done()
  var d = opts.date || new Date
  var username = opts.username || self.username
  self.db.get(`${channel}/latest`, function (err, node) {
    if (err) node = {value: 0}
    var latest = parseInt(node.value)
    var newLatest = latest + 1
    var key = `${channel}/newLatest`
    var utcDate = new Date(d.valueOf() + d.getTimezoneOffset()*60*1000)
    var date = strftime('%F %T', utcDate)
    self.db.put(key, {username, date, message}, function () {
      self.db.put(`${channel}/latest`, newLatest, done)
    })
  })
}

/**
 * Replication stream for the mesh. Shares the username with the
 * other peers it is connecting with.
 */
Mesh.prototype.replicate = function () {
  var self = this
  return this.db.replicate({
    live: true,
    userData: JSON.stringify({
      key: self.db.local.key,
      username: self.username
    })
  })
}
