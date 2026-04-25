// Firebase setup and Firestore helpers for OSRS Bingo

const firebaseConfig = {
  apiKey: "AIzaSyAQqBlbqmEqKhw5BeA1SJn30zQJfA5kUT4",
  authDomain: "osrs-bingo-226d4.firebaseapp.com",
  projectId: "osrs-bingo-226d4",
  storageBucket: "osrs-bingo-226d4.firebasestorage.app",
  messagingSenderId: "887145573574",
  appId: "1:887145573574:web:a179476c72a4fdcf6a3bc7"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

async function fbEnsureAuth() {
  if (auth.currentUser) return auth.currentUser;
  const cred = await auth.signInAnonymously();
  return cred.user;
}

async function fbPublishEvent(cardPayload) {
  const user = await fbEnsureAuth();
  const ref = await db.collection('events').add({
    card: cardPayload,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    creatorUid: user.uid,
  });
  return ref.id;
}

async function fbLoadEvent(eventId) {
  const doc = await db.collection('events').doc(eventId).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function fbCreateTeam(eventId, teamName) {
  await fbEnsureAuth();
  const ref = await db.collection('events').doc(eventId).collection('teams').add({
    name: teamName,
    players: [],
    crossed: '[]',
    score: 0,
    lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function fbGetTeams(eventId) {
  const snap = await db.collection('events').doc(eventId).collection('teams').get();
  const teams = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return teams.sort((a, b) => (b.score || 0) - (a.score || 0));
}

async function fbSaveTeamProgress(eventId, teamId, crossed, score, players, teamName, tilesComplete) {
  await db.collection('events').doc(eventId).collection('teams').doc(teamId).update({
    crossed: JSON.stringify(crossed),
    score,
    tilesComplete: tilesComplete || 0,
    players,
    name: teamName,
    lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

function fbListenTeam(eventId, teamId, callback) {
  return db.collection('events').doc(eventId).collection('teams').doc(teamId)
    .onSnapshot(doc => { if (doc.exists) callback(doc.data()); });
}

function fbListenAllTeams(eventId, callback) {
  return db.collection('events').doc(eventId).collection('teams')
    .onSnapshot(snap => {
      const teams = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(teams.sort((a, b) => (b.score || 0) - (a.score || 0)));
    });
}
