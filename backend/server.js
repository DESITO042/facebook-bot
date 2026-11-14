const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const APP_ID = '1441460227437949';
const APP_SECRET = process.env.APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';
const VERIFY_TOKEN = 'desito123';

// ===== ADMIN - PUT YOUR FACEBOOK ID HERE =====
const ADMIN_IDS = ['993196283840188'];
function isAdmin(req){
  const sess = getSession(req);
  return sess && ADMIN_IDS.includes(String(sess.userId));
}

// ===== USER SESSIONS - In-memory (ok for now, sessions expire on restart) =====
let SESSIONS = {};
function getSession(req){
  let cookieHeader = req.headers.cookie || '';
  let match = cookieHeader.match(/sessionId=([^;]+)/);
  if(!match) return null;
  return SESSIONS[match[1]] || null;
}

// ===== MONGODB - REPLACES pages.json + HANDOVER =====
const client = new MongoClient(process.env.MONGODB_URI);
let pagesCollection;
let handoverCollection;

async function connectDB() {
  try {
    await client.connect();
    const db = client.db('Desitobot');
    pagesCollection = db.collection('pages');
    handoverCollection = db.collection('handover');
    await pagesCollection.createIndex({ pageId: 1 }, { unique: true });
    await handoverCollection.createIndex({ key: 1 }, { unique: true });
    // Auto-delete expired handovers
    await handoverCollection.createIndex({ pausedUntil: 1 }, { expireAfterSeconds: 0 });
    console.log('✅ MongoDB Connected - DesitoBot');
  } catch (e) {
    console.log('❌ MongoDB Failed:', e.message);
  }
}
connectDB();

// ===== PAGES HELPERS - Now MongoDB, async =====
async function readPages() {
  if (!pagesCollection) return [];
  return await pagesCollection.find({}).toArray();
}
async function getPage(pageId) {
  if (!pagesCollection) return null;
  return await pagesCollection.findOne({ pageId: String(pageId) });
}
async function savePage(pageData) {
  if (!pagesCollection) return;
  await pagesCollection.updateOne(
    { pageId: String(pageData.pageId) },
    { $set: { ...pageData, pageId: String(pageData.pageId), updatedAt: new Date() } },
    { upsert: true }
  );
}
async function deletePage(pageId) {
  if (!pagesCollection) return;
  await pagesCollection.deleteOne({ pageId: String(pageId) });
}

// ===== HANDOVER HELPERS - Now MongoDB =====
async function getHandover(key) {
  if (!handoverCollection) return null;
  const h = await handoverCollection.findOne({ key });
  if (!h) return null;
  if (Date.now() >= h.pausedUntil) {
    await handoverCollection.deleteOne({ key });
    return null;
  }
  return h;
}
async function setHandover(key, data) {
  if (!handoverCollection) return;
  await handoverCollection.updateOne({ key }, { $set: { key, ...data } }, { upsert: true });
}
async function clearHandover(key) {
  if (!handoverCollection) return;
  await handoverCollection.deleteOne({ key });
}
async function listHandover() {
  if (!handoverCollection) return [];
  const all = await handoverCollection.find({}).toArray();
  return all.map(h => ({ ...h, minsLeft: Math.ceil((h.pausedUntil - Date.now())/60000) }));
}

async function autoSubscribePage(pageId, pageToken) {
  if (!pageId || !pageToken) return { success: false, error: 'No Page Token' };
  try {
    console.log(`AUTO-SUBSCRIBING Page ${pageId}...`);
    const fbRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: pageToken, subscribed_fields: 'messages,messaging_postbacks,feed,mention' })
    });
    const data = await fbRes.json();
    console.log('AUTO-SUBSCRIBE RESULT for', pageId, ':', data);
    if (data.success === true) return { success: true, data };
    return { success: false, error: data.error?.message || JSON.stringify(data) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 1. WEBHOOK VERIFY =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else { res.sendStatus(403); }
});

// ===== 2. WEBHOOK RECEIVE =====
app.post('/webhook', (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    body.entry.forEach(entry => {
      if (entry.changes) {
        entry.changes.forEach(change => {
          if (change.field === 'feed' && change.value.item === 'comment') {
            handleWithBrain(entry.id, change.value.message, 'comment', change.value.comment_id);
          }
        });
      }
      if (entry.messaging) {
        entry.messaging.forEach(event => {
          if (event.message && event.message.text) {
            handleWithBrain(event.recipient.id, event.message.text, 'message', event.sender.id);
          }
        });
      }
    });
    res.status(200).send('EVENT_RECEIVED');
  } else { res.sendStatus(404); }
});

// ===== 3. BRAIN + REPLY - WITH SETTINGS + MONGODB =====
async function handleWithBrain(pageId, userText, type, targetId) {
  try {
    const page = await getPage(pageId);
    if (!page) return;
    const businessName = page.name;

    // CHECK IF THIS PERSON DEY PAUSED (HANDOVER - MONGODB)
    let key = `${pageId}_${targetId}`;
    let paused = await getHandover(key);
    if (paused) {
      console.log(`⏸️ Paused for ${key}, human dey handle am`);
      return;
    }

    // CHECK TOGGLES
    if (type === 'message' && page.autoReplyEnabled === false) return;
    if (type === 'comment' && page.autoCommentEnabled === false) return;

    // HANDOVER KEYWORDS
    let lower = (userText || '').toLowerCase();
    let humanWords = ['human','person','agent','talk to person','speak to person','call me','real person','customer care','support','i want human','let me talk to human','operator'];
    let wantHuman = humanWords.some(w => lower.includes(w));

    if (wantHuman && type === 'message') {
      await setHandover(key, { pausedUntil: Date.now() + (60 * 60 * 1000), reason: userText, at: new Date().toISOString(), pageId: String(pageId), senderId: String(targetId) });
      let reply = "Okay, I don call human for you 🙏 Person go reply you soon. Abeg wait small.";
      await fetch(`https://graph.facebook.com/v21.0/me/messages`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ recipient: { id: targetId }, message: { text: reply }, access_token: page.accessToken })
      });
      console.log(`🔴 HANDOVER: ${key} paused for 1 hour`);
      return;
    }

    // WELCOME MESSAGE
    let greetings = ['hi','hello','hey','good morning','good afternoon','good evening','yo','sup'];
    if (type === 'message' && greetings.includes(lower.trim()) && page.welcomeMessage) {
      await fetch(`https://graph.facebook.com/v21.0/me/messages`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ recipient: { id: targetId }, message: { text: page.welcomeMessage }, access_token: page.accessToken })
      });
      return;
    }

    // NORMAL BRAIN REPLY - DYNAMIC NAME, NO HARDCODE
    const brainRes = await fetch(process.env.BRAIN_URL || 'http://localhost:8000/chat', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ message: userText, knowledge: page.knowledge || '', page_name: businessName, business_name: businessName })
    });
    const brainData = await brainRes.json();
    let reply = brainData.reply || `Hi, I'm Desito Bot, AI assistant for ${businessName}. How I fit help you?`;
    const endpoint = type === 'comment' ? `https://graph.facebook.com/v21.0/${targetId}/comments` : `https://graph.facebook.com/v21.0/me/messages`;
    const body = type === 'comment' ? { message: reply, access_token: page.accessToken } : { recipient: { id: targetId }, message: { text: reply }, access_token: page.accessToken };
    await fetch(endpoint, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  } catch(e){ console.log('Brain error:', e.message); }
}

// 4. Login
app.get('/auth/facebook', (req, res) => {
  const scope = 'pages_show_list,pages_read_engagement,pages_messaging,pages_manage_posts,pages_manage_metadata,business_management,public_profile';
  const next = req.query.next || '/dashboard.html?connected=true';
  const state = encodeURIComponent(next);
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&auth_type=rerequest&state=${state}`;
  res.redirect(url);
});

// Who am I?
app.get('/api/me', (req, res) => {
  const sess = getSession(req);
  if(!sess) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, userId: sess.userId, userName: sess.userName });
});

// 5. Callback - NOW MONGODB
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send('Facebook Login Cancelled: ' + error);
  if (!code) return res.send('No code from Facebook');
  try {
    let tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_secret=${APP_SECRET}&code=${code}`);
    let tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.send('Token Failed: ' + JSON.stringify(tokenData));
    const userToken = tokenData.access_token;

    let meRes = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${userToken}`);
    let meData = await meRes.json();
    console.log('LOGGED IN USER:', meData);
    const userId = meData.id;
    const userName = meData.name || 'User';

    const sessionId = crypto.randomBytes(16).toString('hex');
    SESSIONS[sessionId] = { userId, userName, userToken };

    let pagesRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token,category&access_token=${userToken}`);
    let pagesData = await pagesRes.json();

    if (!pagesData.data || pagesData.data.length === 0) {
      let bizRes = await fetch(`https://graph.facebook.com/v19.0/me/businesses?fields=id,name&access_token=${userToken}`);
      let bizData = await bizRes.json();
      if (bizData.data && bizData.data.length > 0) {
        for (let biz of bizData.data) {
          let ownedRes = await fetch(`https://graph.facebook.com/v19.0/${biz.id}/owned_pages?fields=id,name,access_token,category&access_token=${userToken}`);
          let ownedData = await ownedRes.json();
          if (ownedData.data && ownedData.data.length > 0) { pagesData = ownedData; break; }
          let clientRes = await fetch(`https://graph.facebook.com/v19.0/${biz.id}/client_pages?fields=id,name,access_token,category&access_token=${userToken}`);
          let clientData = await clientRes.json();
          if (clientData.data && clientData.data.length > 0) { pagesData = clientData; break; }
        }
      }
    }
    if (!pagesData.data || pagesData.data.length === 0) {
      res.setHeader('Set-Cookie', `sessionId=${sessionId}; Path=/; HttpOnly; Max-Age=86400`);
      return res.send('No Pages found. Are you Admin of any Page? <br><br><a href="/admin.html">Go to Admin</a> | <a href="/dashboard.html">Go to Dashboard</a>');
    }

    for (let p of pagesData.data) {
      const existing = await getPage(p.id);
      const sub = await autoSubscribePage(p.id, p.access_token);
      if (!existing) {
        await savePage({ name: p.name, pageId: String(p.id), accessToken: p.access_token, status: 'Connected', subscribed: sub.success, subscribeError: sub.success ? '' : (sub.error || ''), knowledge: '', userId, userName, welcomeMessage: 'Welcome! 🙏 How we fit help you today? Press 1 for Price, 2 for Order, 3 for Human.', autoReplyEnabled: true, autoCommentEnabled: true, category: p.category || '' });
      } else {
        if (existing.userId === userId || !existing.userId) {
          await savePage({ ...existing, accessToken: p.access_token, userId, userName, subscribed: sub.success, subscribeError: sub.success ? '' : (sub.error || '') });
        } else {
          console.log(`Page ${p.name} already belongs to another user (${existing.userName}), skipping for ${userName}`);
        }
      }
    }
    let goTo = '/dashboard.html?connected=true';
    try { if (req.query.state) goTo = decodeURIComponent(req.query.state); } catch(e){}
    if (!goTo.startsWith('/')) goTo = '/dashboard.html?connected=true';
    res.setHeader('Set-Cookie', `sessionId=${sessionId}; Path=/; HttpOnly; Max-Age=86400`);
    res.redirect(goTo);
  } catch (err) {
    console.log('CALLBACK ERROR:', err);
    res.send('Server Error: ' + err.message);
  }
});

// 6. Dashboard fetch - ONLY YOUR PAGES - MONGODB
app.get('/api/pages', async (req, res) => {
  const sess = getSession(req);
  let all = await readPages();
  if (!sess) return res.json(all.filter(p => !p.userId));
  let mine = all.filter(p => String(p.userId) === String(sess.userId));
  console.log(`Pages for ${sess.userName} (${sess.userId}): ${mine.length} / ${all.length} total`);
  res.json(mine);
});

// 7. Manual add - MONGODB
app.post('/api/pages', async (req, res) => {
  const sess = getSession(req);
  const { name, pageId, accessToken } = req.body;
  if (!name || !pageId) return res.json({ success: false, msg: 'Fill Page Name and Page ID' });
  const existing = await getPage(pageId);
  if (existing) return res.json({ success: false, msg: 'Page already added' });
  const sub = await autoSubscribePage(pageId, accessToken);
  await savePage({ name, pageId: String(pageId), accessToken, status: 'Connected', subscribed: sub.success, subscribeError: sub.success ? '' : (sub.error || ''), knowledge: '', userId: sess ? sess.userId : '', userName: sess ? sess.userName : 'Manual', welcomeMessage: 'Welcome! 🙏 How we fit help you today?', autoReplyEnabled: true, autoCommentEnabled: true });
  res.json({ success: true, msg: sub.success ? 'Page Added + Auto-Subscribed ✅' : 'Page Added, but Auto-Subscribe failed: ' + (sub.error || '') });
});

// SAVE KNOWLEDGE - MONGODB
app.post('/api/pages/:pageId/knowledge', async (req, res) => {
  const sess = getSession(req);
  const { pageId } = req.params;
  const { knowledge } = req.body;
  const page = await getPage(pageId);
  if (!page) return res.json({ success: false, message: 'Page not found' });
  if (page.userId && sess && String(page.userId) !== String(sess.userId)) {
    return res.json({ success: false, message: 'This Page no belong to you' });
  }
  await savePage({ ...page, knowledge: knowledge || '' });
  console.log(`Knowledge saved for ${page.name} by ${sess?.userName || 'Manual'} to MongoDB`);
  res.json({ success: true });
});

app.get('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sessionId=; Path=/; Max-Age=0');
  res.redirect('/dashboard.html');
});

// ADMIN: See ALL Pages - MONGODB
app.get('/api/admin/pages', async (req, res) => {
  const sess = getSession(req);
  if(!isAdmin(req)) return res.json({ success: false, msg: 'Only Admin fit see this - your ID: ' + (sess ? sess.userId : 'Not logged in') });
  res.json(await readPages());
});

// ADMIN: Disconnect Page - MONGODB
app.delete('/api/admin/pages/:pageId', async (req, res) => {
  if(!isAdmin(req)) return res.json({ success: false, msg: 'Only Admin' });
  const page = await getPage(req.params.pageId);
  if(!page) return res.json({ success: false, msg: 'Page not found' });
  try{
    if(page.accessToken){
      await fetch(`https://graph.facebook.com/v21.0/${req.params.pageId}/subscribed_apps?access_token=${page.accessToken}`, { method: 'DELETE' });
      console.log(`Unsubscribed Page ${req.params.pageId} from Meta`);
    }
  }catch(e){ console.log('Unsubscribe failed:', e.message); }
  await deletePage(req.params.pageId);
  console.log(`Admin disconnected Page ${req.params.pageId}`);
  res.json({ success: true, msg: 'Page disconnected ✅' });
});

// USER: Disconnect his own page - MONGODB
app.delete('/api/pages/:pageId', async (req, res) => {
  const sess = getSession(req);
  const page = await getPage(req.params.pageId);
  if(!page) return res.json({ success: false, msg: 'Page not found' });
  if(page.userId && sess && String(page.userId) !== String(sess.userId) && !isAdmin(req)){
    return res.json({ success: false, msg: 'This Page no belong to you' });
  }
  try{
    if(page.accessToken){
      await fetch(`https://graph.facebook.com/v21.0/${req.params.pageId}/subscribed_apps?access_token=${page.accessToken}`, { method: 'DELETE' });
    }
  }catch(e){}
  await deletePage(req.params.pageId);
  res.json({ success: true });
});

// SAVE SETTINGS - MONGODB
app.post('/api/pages/:pageId/settings', async (req, res) => {
  const sess = getSession(req);
  const { pageId } = req.params;
  const { welcomeMessage, autoReplyEnabled, autoCommentEnabled } = req.body;
  const page = await getPage(pageId);
  if (!page) return res.json({ success: false, message: 'Page not found' });
  if (page.userId && sess && String(page.userId) !== String(sess.userId) && !isAdmin(req)) {
    return res.json({ success: false, message: 'This Page no belong to you' });
  }
  let update = { ...page };
  if (welcomeMessage !== undefined) update.welcomeMessage = welcomeMessage;
  if (autoReplyEnabled !== undefined) update.autoReplyEnabled = autoReplyEnabled;
  if (autoCommentEnabled !== undefined) update.autoCommentEnabled = autoCommentEnabled;
  await savePage(update);
  console.log(`Settings saved for ${page.name}`);
  res.json({ success: true, message: 'Settings saved ✅' });
});

// HANDOVER - LIST + RESUME - MONGODB
app.get('/api/handover', async (req, res) => {
  res.json(await listHandover());
});

app.post('/api/handover/resume', async (req, res) => {
  const { key } = req.body;
  await clearHandover(key);
  res.json({ success: true, message: 'Bot don resume for this person ✅' });
});

// app.listen(3000, () => console.log('Running on http://localhost:3000'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port ' + PORT));