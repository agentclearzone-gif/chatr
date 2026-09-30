'use strict';
/*
 * Chat rooms, managed from the admin panel (Rooms page) and saved through store.js (database or data/rooms.json).
 * A room can have a password: it is stored as a salted scrypt hash, never in plain text, and
 * checked asynchronously so password attempts can't stall the chat for everyone else.
 */
const crypto = require('crypto');

const MAX_ROOMS = 100;
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, key) => (e ? rej(e) : res(key))));

class Rooms {
  constructor(store) {
    this.store = store;
    const saved = store.get('rooms');
    this.list = Array.isArray(saved) && saved.length ? saved : [
      { id: 'main', name: 'Main Room', desc: 'Everyone joins here — keep it friendly', pw: null, created: Date.now() },
    ];
  }

  save() {
    this.store.set('rooms', this.list);
  }

  get(id) { return this.list.find(r => r.id === id); }

  /** What users see (never the password hash). */
  publicList() { return this.list.map(r => ({ id: r.id, name: r.name, desc: r.desc, locked: !!r.pw })); }

  validate({ name, desc, password }, except) {
    const n = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    if (n.length < 2 || n.length > 30) throw new Error('Room name must be 2–30 characters');
    if (this.list.some(r => r !== except && r.name.toLowerCase() === n.toLowerCase())) throw new Error('A room with that name already exists');
    const d = typeof desc === 'string' ? desc.replace(/\s+/g, ' ').trim() : '';
    if (d.length > 120) throw new Error('Description must be at most 120 characters');
    if (password !== undefined && password !== null && password !== '' && (typeof password !== 'string' || password.length < 4 || password.length > 64)) {
      throw new Error('Password must be 4–64 characters');
    }
    return { name: n, desc: d };
  }

  async hash(password) {
    const salt = crypto.randomBytes(16);
    return `${salt.toString('base64')}:${(await scrypt(password, salt)).toString('base64')}`;
  }

  async create({ name, desc, password }) {
    if (this.list.length >= MAX_ROOMS) throw new Error(`You can have at most ${MAX_ROOMS} rooms`);
    const v = this.validate({ name, desc, password });
    const room = { id: crypto.randomBytes(4).toString('hex'), ...v, pw: password ? await this.hash(password) : null, created: Date.now() };
    this.list.push(room);
    this.save();
    return room;
  }

  /** password: undefined = keep, '' or null = remove, string = set new */
  async update(id, { name, desc, password }) {
    const room = this.get(id);
    if (!room) throw new Error('Room not found');
    const v = this.validate({ name: name ?? room.name, desc: desc ?? room.desc, password }, room);
    Object.assign(room, v);
    if (password === '' || password === null) room.pw = null;
    else if (typeof password === 'string') room.pw = await this.hash(password);
    this.save();
    return room;
  }

  remove(id) {
    const i = this.list.findIndex(r => r.id === id);
    if (i < 0) return null;
    const [room] = this.list.splice(i, 1);
    this.save();
    return room;
  }

  move(id, dir) {
    const i = this.list.findIndex(r => r.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= this.list.length) return;
    [this.list[i], this.list[j]] = [this.list[j], this.list[i]];
    this.save();
  }

  async checkPassword(room, password) {
    if (!room.pw) return true;
    if (typeof password !== 'string' || !password || password.length > 64) return false;
    const [salt, hash] = room.pw.split(':');
    const given = await scrypt(password, Buffer.from(salt, 'base64'));
    return crypto.timingSafeEqual(given, Buffer.from(hash, 'base64'));
  }
}

module.exports = Rooms;
