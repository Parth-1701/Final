// ═══════════════════════════════════════════════════════════════════
// firebase.js  —  ExamForge Firebase Configuration
// ═══════════════════════════════════════════════════════════════════
// 
// HOW TO GET YOUR CONFIG:
//   1. Go to https://console.firebase.google.com
//   2. Create a project (or open existing one)
//   3. Click the gear icon → Project Settings
//   4. Scroll to "Your apps" → click the </> (Web) icon
//   5. Register your app, then copy the firebaseConfig object below
//   6. In the left sidebar, go to:
//       - Build → Authentication → Get started → Enable Email/Password + Google
//       - Build → Firestore Database → Create database (start in test mode)
//
// ═══════════════════════════════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword,
         createUserWithEmailAndPassword, GoogleAuthProvider,
         signInWithPopup, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs,
         addDoc, setDoc, updateDoc, query, where, orderBy, limit, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ─── PASTE YOUR CONFIG HERE ───────────────────────────────────────
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
// ──────────────────────────────────────────────────────────────────

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

export { auth, db };

// ═══════════════════════════════════════════════════════════════════
// AUTH HELPERS
// ═══════════════════════════════════════════════════════════════════

export async function loginWithEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signupWithEmail(email, password, displayName, targetExam) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  // Save extra profile info to Firestore
  await setDoc(doc(db, "users", cred.user.uid), {
    displayName,
    email,
    targetExam,
    createdAt: serverTimestamp(),
    role: "student"
  });
  return cred.user;
}

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(auth, provider);
  // Create user doc if first time
  const userRef = doc(db, "users", cred.user.uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    await setDoc(userRef, {
      displayName: cred.user.displayName,
      email: cred.user.email,
      createdAt: serverTimestamp(),
      role: "student"
    });
  }
  return cred.user;
}

export function logout() {
  return signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

// ═══════════════════════════════════════════════════════════════════
// TEST / QUESTION HELPERS
// ═══════════════════════════════════════════════════════════════════

// Fetch all available tests (for homepage listing)
export async function getTests(examType = null) {
  let q = examType
    ? query(collection(db, "tests"), where("examType", "==", examType), orderBy("createdAt", "desc"))
    : query(collection(db, "tests"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Fetch a single test's metadata
export async function getTest(testId) {
  const snap = await getDoc(doc(db, "tests", testId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Fetch all questions for a test
export async function getQuestions(testId) {
  const snap = await getDocs(
    query(collection(db, "tests", testId, "questions"), orderBy("order"))
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ═══════════════════════════════════════════════════════════════════
// RESULT HELPERS
// ═══════════════════════════════════════════════════════════════════

// Save result after test submission
export async function saveResult(testId, responses, timeTaken) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");

  const questions = await getQuestions(testId);

  let score = 0, correct = 0, wrong = 0, unattempted = 0;

  responses.forEach((r, i) => {
    const q = questions[i];
    if (!q) return;
    if (r.ans === null || r.ans === undefined) {
      unattempted++;
      return;
    }
    if (q.type === "mcq") {
      if (r.ans === q.correctAns) { score += (q.posMarks || 4); correct++; }
      else { score += (q.negMarks || -1); wrong++; }
    } else {
      // Numerical: compare as strings (trim whitespace)
      const userAns = String(r.ans).trim();
      const correctAns = String(q.correctAns).trim();
      if (userAns === correctAns) { score += (q.posMarks || 4); correct++; }
      else if (r.ans !== null) { wrong++; }
    }
  });

  const resultData = {
    userId:       user.uid,
    userEmail:    user.email,
    testId,
    score,
    correct,
    wrong,
    unattempted,
    timeTaken,    // seconds
    responses:    responses.map(r => ({ ans: r.ans, flagged: r.flagged })),
    submittedAt:  serverTimestamp()
  };

  const ref = await addDoc(collection(db, "results"), resultData);

  // Update leaderboard entry (keep only best score per user per test)
  const lbRef = doc(db, "leaderboard", `${testId}_${user.uid}`);
  const existing = await getDoc(lbRef);
  if (!existing.exists() || existing.data().score < score) {
    await setDoc(lbRef, {
      userId:      user.uid,
      displayName: user.displayName || user.email,
      testId,
      score,
      timeTaken,
      updatedAt:   serverTimestamp()
    });
  }

  return { id: ref.id, ...resultData };
}

// Get leaderboard for a test
export async function getLeaderboard(testId, limitCount = 10) {
  const snap = await getDocs(
    query(
      collection(db, "leaderboard"),
      where("testId", "==", testId),
      orderBy("score", "desc"),
      orderBy("timeTaken", "asc"),
      limit(limitCount)
    )
  );
  return snap.docs.map(d => d.data());
}

// Get a user's past results
export async function getUserResults(userId) {
  const snap = await getDocs(
    query(collection(db, "results"), where("userId", "==", userId), orderBy("submittedAt", "desc"))
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}


// ═══════════════════════════════════════════════════════════════════
// FIRESTORE SECURITY RULES  (paste into Firebase Console → Firestore → Rules)
// ═══════════════════════════════════════════════════════════════════
/*
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Users can read/write their own profile
    match /users/{userId} {
      allow read, write: if request.auth.uid == userId;
    }

    // Tests and questions: anyone authenticated can read; only admins can write
    match /tests/{testId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';

      match /questions/{qId} {
        allow read: if request.auth != null;
        allow write: if request.auth != null &&
          get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
      }
    }

    // Results: users can create their own; read their own
    match /results/{resultId} {
      allow create: if request.auth != null && request.resource.data.userId == request.auth.uid;
      allow read: if request.auth != null && resource.data.userId == request.auth.uid;
    }

    // Leaderboard: authenticated users can read; only system can write (via saveResult)
    match /leaderboard/{entryId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.resource.data.userId == request.auth.uid;
    }
  }
}
*/


// ═══════════════════════════════════════════════════════════════════
// FIRESTORE DATA STRUCTURE  (for reference)
// ═══════════════════════════════════════════════════════════════════
/*
Firestore collections:

users/
  {uid}/
    displayName: "Arjun Rao"
    email: "arjun@example.com"
    targetExam: "JEE Mains"
    role: "student" | "admin"
    createdAt: Timestamp

tests/
  {testId}/
    title: "JEE Mains — Mock Test 01"
    examType: "jee_mains" | "jee_advanced" | "mht_cet" | "bitsat"
    duration: 10800          // seconds (3 hours)
    totalQuestions: 90
    totalMarks: 300
    sections: [
      { name: "Physics", start: 0, end: 29 },
      { name: "Chemistry", start: 30, end: 59 },
      { name: "Mathematics", start: 60, end: 89 }
    ]
    createdAt: Timestamp
    isPublished: true

    questions/           ← subcollection
      {qId}/
        order: 1
        section: 0        // 0=Physics, 1=Chem, 2=Maths
        sectionSub: "A"   // "A" = MCQ, "B" = Numerical
        type: "mcq" | "integer"
        text: "A particle executes..."
        options: ["opt A", "opt B", "opt C", "opt D"]  // empty for integer
        correctAns: 0     // index for MCQ, string value for integer
        posMarks: 4
        negMarks: -1      // 0 for integer type

results/
  {resultId}/
    userId: "uid123"
    testId: "testId456"
    score: 212
    correct: 55
    wrong: 8
    unattempted: 27
    timeTaken: 9240       // seconds
    responses: [{ ans: 2, flagged: false }, ...]
    submittedAt: Timestamp

leaderboard/
  {testId}_{userId}/
    userId: "uid123"
    displayName: "Arjun Rao"
    testId: "testId456"
    score: 212
    timeTaken: 9240
    updatedAt: Timestamp
*/
