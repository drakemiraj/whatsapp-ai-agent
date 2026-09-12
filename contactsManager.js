const fs = require('fs');
const path = require('path');

const CONTACTS_JSON_PATH = path.join(__dirname, 'contacts.json');
const AUTH_DIR = path.join(__dirname, 'baileys_auth');

let contactsCache = {};

// Load contacts from disk
function loadContacts() {
  if (fs.existsSync(CONTACTS_JSON_PATH)) {
    try {
      contactsCache = JSON.parse(fs.readFileSync(CONTACTS_JSON_PATH, 'utf-8'));
    } catch (e) {
      contactsCache = {};
    }
  } else {
    contactsCache = {};
  }
}

// Save contacts to disk
function saveContacts() {
  try {
    fs.writeFileSync(CONTACTS_JSON_PATH, JSON.stringify(contactsCache, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error saving contacts.json:', e.message);
  }
}

// Resolve real phone number from remoteJid (handles @s.whatsapp.net and @lid)
function resolveRealPhoneNumber(remoteJid) {
  if (!remoteJid) return '';
  
  if (remoteJid.endsWith('@s.whatsapp.net')) {
    return remoteJid.replace('@s.whatsapp.net', '');
  }

  if (remoteJid.endsWith('@lid')) {
    const lid = remoteJid.replace('@lid', '');
    // Check baileys_auth lid-mapping reverse file
    const reverseFile = path.join(AUTH_DIR, `lid-mapping-${lid}_reverse.json`);
    if (fs.existsSync(reverseFile)) {
      try {
        const raw = fs.readFileSync(reverseFile, 'utf-8');
        const clean = JSON.parse(raw);
        if (clean) return String(clean).replace(/[^0-9]/g, '');
      } catch (e) {}
    }
    return lid;
  }

  return remoteJid.replace(/[^0-9]/g, '');
}

// Update contact info from WhatsApp events
function updateContact(id, data = {}) {
  loadContacts();
  const phone = resolveRealPhoneNumber(id);
  if (!phone) return;

  if (!contactsCache[phone]) {
    contactsCache[phone] = {
      phone,
      name: '',
      pushName: '',
      updatedAt: new Date().toISOString()
    };
  }

  if (data.name && data.name.trim()) {
    contactsCache[phone].name = data.name.trim();
  }
  if (data.notify && data.notify.trim()) {
    contactsCache[phone].pushName = data.notify.trim();
  }
  if (data.pushName && data.pushName.trim()) {
    contactsCache[phone].pushName = data.pushName.trim();
  }

  contactsCache[phone].updatedAt = new Date().toISOString();
  saveContacts();
}

// Get contact details for a phone number
function getContact(id) {
  loadContacts();
  const phone = resolveRealPhoneNumber(id);
  return contactsCache[phone] || { phone, name: '', pushName: '' };
}

// Get best display name (Saved Phonebook Name > WhatsApp PushName > null)
function getBestContactName(id) {
  const contact = getContact(id);
  if (contact.name && contact.name.trim()) return contact.name.trim();
  if (contact.pushName && contact.pushName.trim()) return contact.pushName.trim();
  return null;
}

// Initialize
loadContacts();

module.exports = {
  resolveRealPhoneNumber,
  updateContact,
  getContact,
  getBestContactName
};
