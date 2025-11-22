// ============================================
// IIIT NR Attendance System - Backend Server
// ============================================
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
require('dotenv').config();

// Initialize Firebase Admin
const admin = require('firebase-admin');

// Use environment variable for Firebase credentials (for Render/production)
// or fall back to local service account file (for local development)
let serviceAccount;

console.log('🔍 Checking Firebase credentials...');
console.log('Environment variable FIREBASE_SERVICE_ACCOUNT_JSON exists:', !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
console.log('Environment variable length:', process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? process.env.FIREBASE_SERVICE_ACCOUNT_JSON.length : 0);

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  // Production: Use service account from environment variable
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    console.log('✅ Using Firebase service account from environment variable');
    console.log('Project ID:', serviceAccount.project_id);
  } catch (error) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', error.message);
    console.error('First 100 chars:', process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.substring(0, 100));
    process.exit(1);
  }
} else {
  // Development: Use local service account file
  try {
    serviceAccount = require('./iiitnr-attendence-app-f604e-firebase-adminsdk-fbsvc-e79f0f1be5.json');
    console.log('✅ Using Firebase service account from local file');
  } catch (error) {
    console.error('❌ Firebase service account not found.');
    console.error('Please set FIREBASE_SERVICE_ACCOUNT_JSON environment variable in Render dashboard.');
    console.error('Or add the iiitnr-attendence-app-f604e-firebase-adminsdk-fbsvc-e79f0f1be5.json file locally.');
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();
const auth = admin.auth();

// Safer Firestore writes: ignore undefined values globally as a fallback
db.settings({ ignoreUndefinedProperties: true });

// Initialize Express
const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:8080',
    'http://localhost:5173',
    'http://localhost:3000',
    'https://iiitnrattendence.netlify.app',
    'https://iiitnrattendence.vercel.app',
    'https://rahull-prog.github.io',
    'https://kydrahul.github.io'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id']
}));
app.use(compression());
app.use(express.json({ limit: '1mb' })); // Add size limit
app.use(morgan('dev'));

// ============================================
// IN-MEMORY CACHE IMPLEMENTATION
// ============================================

// Simple LRU cache (no external dependencies needed)
class SimpleCache {
  constructor(maxSize = 1000, ttl = 3600000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl; // 1 hour default
  }

  set(key, value) {
    // Remove oldest entry if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    // Check if expired
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  invalidate(pattern) {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      usage: `${((this.cache.size / this.maxSize) * 100).toFixed(1)}%`
    };
  }
}

// Initialize caches
const studentCache = new SimpleCache(500, 3600000); // 500 students, 1 hour TTL
const courseCache = new SimpleCache(200, 3600000); // 200 courses, 1 hour TTL
const facultyCache = new SimpleCache(100, 3600000); // 100 faculty, 1 hour TTL

console.log('✅ In-memory cache initialized');

// Cache invalidation helpers
function invalidateStudentCache(studentId) {
  studentCache.invalidate(`student:${studentId}`);
  studentCache.invalidate(`dashboard:${studentId}`);
  studentCache.invalidate(`timetable:${studentId}`);
}

function invalidateCourseCache(courseId) {
  courseCache.invalidate(`course:${courseId}`);
  // Invalidate all student dashboards (they might have this course)
  studentCache.invalidate('dashboard:');
  studentCache.invalidate('timetable:');
}

// ============================================
// RATE LIMITING (In-Memory)
// ============================================

const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 100; // 100 requests per window

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }

  const record = requestCounts.get(ip);

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: 'Too many requests. Please try again later.',
      retryAfter: Math.ceil((record.resetTime - now) / 1000)
    });
  }

  record.count++;
  next();
}

// Apply rate limiting to API routes
app.use('/api/', rateLimiter);

// Clean up old rate limit records every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of requestCounts.entries()) {
    if (now > record.resetTime) {
      requestCounts.delete(ip);
    }
  }
}, 30 * 60 * 1000);

console.log('✅ Rate limiting enabled (100 req/15min per IP)');


// ============================================
// UTILITY FUNCTIONS
// ============================================

// Calculate distance between two coordinates using Haversine formula (in meters)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in meters
}

// Remove keys with undefined values (Firestore doesn't allow undefined)
function cleanObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  );
}

// Generate secure QR payload with signature
function generateQRPayload(sessionId, courseId, facultyId, location, expiresIn = 300000) {
  const timestamp = Date.now();
  const expiresAt = timestamp + expiresIn; // Default 5 minutes

  return {
    sessionId,
    courseId,
    facultyId,
    timestamp,
    expiresAt,
    location,
    signature: Buffer.from(`${sessionId}-${timestamp}-${process.env.QR_SECRET || 'fallback-secret'}`).toString('base64')
  };
}

// Verify QR signature
function verifyQRSignature(payload) {
  const expectedSignature = Buffer.from(`${payload.sessionId}-${payload.timestamp}-${process.env.QR_SECRET || 'fallback-secret'}`).toString('base64');
  return payload.signature === expectedSignature;
}

// Middleware to verify Firebase Auth token
async function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    // Provide clearer error reasons for common cases
    if (error?.errorInfo?.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired. Please login again to get a fresh token.' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============================================
// API ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Cache statistics endpoint (for monitoring)
app.get('/api/cache/stats', verifyToken, async (req, res) => {
  try {
    res.json({
      success: true,
      caches: {
        students: studentCache.getStats(),
        courses: courseCache.getStats(),
        faculty: facultyCache.getStats()
      },
      rateLimiting: {
        activeIPs: requestCounts.size
      }
    });
  } catch (error) {
    console.error('Error fetching cache stats:', error);
    res.status(500).json({ error: 'Failed to fetch cache stats' });
  }
});

// ============================================
// STUDENT ROUTES
// ============================================

// Create/Update Student Profile
app.post('/api/student/profile', verifyToken, async (req, res) => {
  try {
    // Support both our original keys and the ones used in the guide
    const {
      name,
      rollNo,
      rollNumber,
      programId,
      year,
      batch,
      semester,
      department,
      email: emailFromBody
    } = req.body;
    const userId = req.user.uid;

    const studentData = cleanObject({
      userId,
      email: req.user.email || emailFromBody,
      name,
      rollNo: rollNo || rollNumber,
      programId,
      year,
      batch,
      semester,
      department,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('students').doc(userId).set(studentData, { merge: true });

    // Invalidate cache when profile is updated
    invalidateStudentCache(userId);

    res.json({ success: true, student: studentData });
  } catch (error) {
    console.error('Error creating student profile:', error);
    res.status(500).json({ error: 'Failed to create student profile' });
  }
});

// Get Student Dashboard (today's classes & attendance stats) - OPTIMIZED
app.get('/api/student/dashboard', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;

    // Check cache first
    const cacheKey = `dashboard:${userId}`;
    const cached = studentCache.get(cacheKey);
    if (cached) {
      console.log(`✅ Cache hit: dashboard for ${userId}`);
      return res.json(cached);
    }

    console.log(`📊 Cache miss: fetching dashboard for ${userId}`);

    // Get student data
    const studentDoc = await db.collection('students').doc(userId).get();
    if (!studentDoc.exists) {
      return res.status(404).json({ error: 'Student profile not found' });
    }

    const student = studentDoc.data();

    // Get enrolled courses (single query)
    const enrollmentsSnapshot = await db.collection('enrollments')
      .where('studentId', '==', userId)
      .where('isActive', '==', true)
      .get();

    const courseIds = enrollmentsSnapshot.docs.map(doc => doc.data().courseId);

    // OPTIMIZED: Batch read courses instead of loop
    const courses = [];
    if (courseIds.length > 0) {
      const courseRefs = courseIds.map(id => db.collection('courses').doc(id));
      const courseDocs = await db.getAll(...courseRefs);

      for (const courseDoc of courseDocs) {
        if (courseDoc.exists) {
          courses.push({ id: courseDoc.id, ...courseDoc.data() });
        }
      }
    }

    // Get today's sessions (optimized with single query)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let sessions = [];
    if (courseIds.length > 0) {
      // Firestore 'in' query supports max 10 items
      const courseIdBatches = [];
      for (let i = 0; i < courseIds.length; i += 10) {
        courseIdBatches.push(courseIds.slice(i, i + 10));
      }

      for (const batch of courseIdBatches) {
        const sessionsSnapshot = await db.collection('sessions')
          .where('courseId', 'in', batch)
          .where('date', '>=', admin.firestore.Timestamp.fromDate(today))
          .where('date', '<', admin.firestore.Timestamp.fromDate(tomorrow))
          .get();

        sessions.push(...sessionsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      }
    }

    // Get attendance stats (single query)
    const attendanceSnapshot = await db.collection('attendance')
      .where('studentId', '==', userId)
      .get();

    const totalClasses = attendanceSnapshot.size;
    const presentCount = attendanceSnapshot.docs.filter(doc => doc.data().status === 'present').length;
    const attendancePercentage = totalClasses > 0 ? (presentCount / totalClasses) * 100 : 0;

    const result = {
      student,
      courses,
      todaySessions: sessions,
      stats: {
        totalClasses,
        presentCount,
        absentCount: totalClasses - presentCount,
        attendancePercentage: attendancePercentage.toFixed(1)
      }
    };

    // Cache for 5 minutes (shorter TTL for dashboard)
    const dashboardCache = new SimpleCache(500, 300000); // 5 minutes
    dashboardCache.set(cacheKey, result);
    studentCache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error('Error fetching dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Scan QR and Mark Attendance - OPTIMIZED with Denormalization
app.post('/api/student/scan-qr', verifyToken, async (req, res) => {
  try {
    const { qrData, latitude, longitude, accuracy } = req.body;
    const userId = req.user.uid;

    // Parse QR data
    let payload;
    try {
      payload = JSON.parse(qrData);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid QR code format' });
    }

    // Verify QR signature
    if (!verifyQRSignature(payload)) {
      return res.status(400).json({ error: 'Invalid QR signature' });
    }

    // Check if QR is expired
    if (Date.now() > payload.expiresAt) {
      return res.status(400).json({ error: 'QR code has expired' });
    }

    // Get session details
    const sessionDoc = await db.collection('sessions').doc(payload.sessionId).get();
    if (!sessionDoc.exists) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionDoc.data();

    // Verify student is enrolled in this course
    const enrollmentSnapshot = await db.collection('enrollments')
      .where('studentId', '==', userId)
      .where('courseId', '==', payload.courseId)
      .where('isActive', '==', true)
      .limit(1)
      .get();

    if (enrollmentSnapshot.empty) {
      return res.status(403).json({ error: 'You are not enrolled in this course' });
    }

    // Check if already marked
    const existingAttendance = await db.collection('attendance')
      .where('sessionId', '==', payload.sessionId)
      .where('studentId', '==', userId)
      .limit(1)
      .get();

    if (!existingAttendance.empty) {
      return res.status(400).json({ error: 'Attendance already marked for this session' });
    }

    // Verify geolocation if required
    let locationVerified = true;
    let distanceFromClass = 0;

    if (payload.location && latitude && longitude) {
      distanceFromClass = calculateDistance(
        latitude,
        longitude,
        payload.location.latitude,
        payload.location.longitude
      );

      const maxDistance = payload.location.radius || 1100; // Default 1100 meters (for indoor GPS inaccuracy)
      locationVerified = distanceFromClass <= maxDistance;

      if (!locationVerified) {
        return res.status(400).json({
          error: `You are too far from class location (${Math.round(distanceFromClass)}m away, max ${maxDistance}m allowed)`,
          distance: Math.round(distanceFromClass),
          maxDistance
        });
      }
    }

    // OPTIMIZED: Get student name with cache
    let studentName = 'Unknown';
    let studentRollNo = 'N/A';
    const cachedStudent = studentCache.get(`student:${userId}`);

    if (cachedStudent) {
      studentName = cachedStudent.name || 'Unknown';
      studentRollNo = cachedStudent.rollNo || 'N/A';
    } else {
      const studentDoc = await db.collection('students').doc(userId).get();
      if (studentDoc.exists) {
        const studentData = studentDoc.data();
        studentName = studentData.name || 'Unknown';
        studentRollNo = studentData.rollNo || 'N/A';
        studentCache.set(`student:${userId}`, studentData);
      }
    }

    // OPTIMIZED: Denormalize student and course info in attendance record
    const attendanceData = {
      sessionId: payload.sessionId,
      courseId: payload.courseId,
      studentId: userId,
      studentName,  // Denormalized - eliminates future reads!
      studentRollNo,  // Denormalized - eliminates future reads!
      courseName: session.courseName || 'Unknown',  // Denormalized
      courseCode: session.courseCode || 'N/A',  // Denormalized
      status: 'present',
      markedAt: admin.firestore.FieldValue.serverTimestamp(),
      markedBy: 'student',
      locationVerified,
      studentLatitude: latitude || null,
      studentLongitude: longitude || null,
      distanceFromClass: Math.round(distanceFromClass),
      accuracy: accuracy || null,
      qrTimestamp: payload.timestamp,
      deviceId: req.headers['x-device-id'] || 'unknown'
    };

    const attendanceRef = await db.collection('attendance').add(attendanceData);

    // Update session present count
    await db.collection('sessions').doc(payload.sessionId).update({
      presentCount: admin.firestore.FieldValue.increment(1)
    });

    // Invalidate dashboard cache
    invalidateStudentCache(userId);

    res.json({
      success: true,
      message: 'Attendance marked successfully!',
      attendance: {
        id: attendanceRef.id,
        ...attendanceData,
        distance: Math.round(distanceFromClass)
      }
    });

  } catch (error) {
    console.error('Error marking attendance:', error);
    res.status(500).json({ error: 'Failed to mark attendance' });
  }
});

// Get Student Attendance History - OPTIMIZED with Pagination
app.get('/api/student/attendance-history', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { courseId, limit = 50, offset = 0 } = req.query;

    let query = db.collection('attendance').where('studentId', '==', userId);

    if (courseId) {
      query = query.where('courseId', '==', courseId);
    }

    // OPTIMIZED: Add pagination
    const snapshot = await query
      .orderBy('markedAt', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset))
      .get();

    // OPTIMIZED: Use denormalized data (no additional reads needed!)
    const attendanceRecords = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        // These are now denormalized in the document
        sessionDate: data.markedAt,
        sessionTime: data.markedAt,
        courseName: data.courseName || 'Unknown',
        courseCode: data.courseCode || 'N/A',
        studentName: data.studentName || 'Unknown',
        studentRollNo: data.studentRollNo || 'N/A'
      };
    });

    res.json({
      attendanceRecords,
      hasMore: snapshot.size === parseInt(limit),
      total: snapshot.size
    });
  } catch (error) {
    console.error('Error fetching attendance history:', error);
    res.status(500).json({ error: 'Failed to fetch attendance history' });
  }
});

// Join Course via Join Code
app.post('/api/student/join-course', verifyToken, async (req, res) => {
  try {
    const { joinCode } = req.body;
    const userId = req.user.uid;

    if (!joinCode) {
      return res.status(400).json({ error: 'Join code is required' });
    }

    // Find course by join code
    const coursesSnapshot = await db.collection('courses')
      .where('joinCode', '==', joinCode.toUpperCase())
      .limit(1)
      .get();

    if (coursesSnapshot.empty) {
      return res.status(404).json({ error: 'Invalid join code' });
    }

    const courseDoc = coursesSnapshot.docs[0];
    const courseId = courseDoc.id;
    const course = courseDoc.data();

    // Check if already enrolled
    const existingEnrollment = await db.collection('enrollments')
      .where('studentId', '==', userId)
      .where('courseId', '==', courseId)
      .limit(1)
      .get();

    if (!existingEnrollment.empty) {
      return res.status(400).json({ error: 'Already enrolled in this course' });
    }

    // Create enrollment
    const enrollmentData = {
      studentId: userId,
      courseId,
      isActive: true,
      enrolledAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('enrollments').add(enrollmentData);

    // Update enrolled count
    await db.collection('courses').doc(courseId).update({
      enrolledCount: admin.firestore.FieldValue.increment(1)
    });

    res.json({
      success: true,
      message: 'Successfully joined course',
      course: { id: courseId, ...course }
    });
  } catch (error) {
    console.error('Error joining course:', error);
    res.status(500).json({ error: 'Failed to join course' });
  }
});

// Get Student's Enrolled Courses - OPTIMIZED with Batch Reads
app.get('/api/student/courses', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;

    // Get enrollments
    const enrollmentsSnapshot = await db.collection('enrollments')
      .where('studentId', '==', userId)
      .where('isActive', '==', true)
      .get();

    const courses = [];
    const courseIds = enrollmentsSnapshot.docs.map(doc => doc.data().courseId);

    // OPTIMIZED: Batch read courses
    if (courseIds.length > 0) {
      const courseRefs = courseIds.map(id => db.collection('courses').doc(id));
      const courseDocs = await db.getAll(...courseRefs);

      // Collect unique faculty IDs
      const facultyIds = [...new Set(
        courseDocs
          .filter(doc => doc.exists && doc.data().facultyId)
          .map(doc => doc.data().facultyId)
      )];

      // OPTIMIZED: Batch read faculty
      const facultyMap = new Map();
      if (facultyIds.length > 0) {
        const facultyRefs = facultyIds.map(id => db.collection('faculty').doc(id));
        const facultyDocs = await db.getAll(...facultyRefs);

        facultyDocs.forEach(doc => {
          if (doc.exists) {
            facultyMap.set(doc.id, doc.data());
            // Cache faculty data
            facultyCache.set(`faculty:${doc.id}`, doc.data());
          }
        });
      }

      // Combine data
      courseDocs.forEach((courseDoc, index) => {
        if (courseDoc.exists) {
          const courseData = courseDoc.data();
          const facultyData = facultyMap.get(courseData.facultyId);

          courses.push({
            id: courseDoc.id,
            ...courseData,
            facultyName: facultyData?.name || 'Unknown',
            enrolledDate: enrollmentsSnapshot.docs[index].data().enrolledAt
          });
        }
      });
    }

    res.json({ success: true, courses });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ error: 'Failed to fetch courses' });
  }
});

// Get Student Timetable (aggregated from all courses) - OPTIMIZED
app.get('/api/student/timetable', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;

    // Check cache
    const cacheKey = `timetable:${userId}`;
    const cached = studentCache.get(cacheKey);
    if (cached) {
      console.log(`✅ Cache hit: timetable for ${userId}`);
      return res.json(cached);
    }

    console.log(`📅 Cache miss: fetching timetable for ${userId}`);

    // Get enrolled courses
    const enrollmentsSnapshot = await db.collection('enrollments')
      .where('studentId', '==', userId)
      .where('isActive', '==', true)
      .get();

    const timetable = {
      Monday: [], Tuesday: [], Wednesday: [],
      Thursday: [], Friday: [], Saturday: []
    };

    const courseIds = enrollmentsSnapshot.docs.map(doc => doc.data().courseId);

    // OPTIMIZED: Batch read courses
    if (courseIds.length > 0) {
      const courseRefs = courseIds.map(id => db.collection('courses').doc(id));
      const courseDocs = await db.getAll(...courseRefs);

      // Collect faculty IDs
      const facultyIds = [...new Set(
        courseDocs
          .filter(doc => doc.exists && doc.data().facultyId)
          .map(doc => doc.data().facultyId)
      )];

      // OPTIMIZED: Batch read faculty
      const facultyMap = new Map();
      if (facultyIds.length > 0) {
        const facultyRefs = facultyIds.map(id => db.collection('faculty').doc(id));
        const facultyDocs = await db.getAll(...facultyRefs);

        facultyDocs.forEach(doc => {
          if (doc.exists) {
            facultyMap.set(doc.id, doc.data());
          }
        });
      }

      // Build timetable
      courseDocs.forEach(courseDoc => {
        if (courseDoc.exists) {
          const course = courseDoc.data();
          const facultyData = facultyMap.get(course.facultyId);

          if (Array.isArray(course.timetable)) {
            course.timetable.forEach(slot => {
              if (timetable[slot.day]) {
                timetable[slot.day].push({
                  time: slot.time,
                  courseCode: course.code,
                  courseName: course.name,
                  type: slot.type,
                  room: slot.room,
                  facultyName: facultyData?.name || 'Unknown'
                });
              }
            });
          }
        }
      });
    }

    // Sort each day's slots by time
    Object.keys(timetable).forEach(day => {
      timetable[day].sort((a, b) => {
        const timeA = a.time.split(' - ')[0];
        const timeB = b.time.split(' - ')[0];
        return timeA.localeCompare(timeB);
      });
    });

    const result = { success: true, timetable };

    // Cache for 1 hour
    studentCache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error('Error fetching timetable:', error);
    res.status(500).json({ error: 'Failed to fetch timetable' });
  }
});


// ============================================
// FACULTY ROUTES
// ============================================

// Create/Update Faculty Profile
app.post('/api/faculty/profile', verifyToken, async (req, res) => {
  try {
    // Accept both minimal and detailed payloads
    const {
      name,
      employeeId,
      designation,
      department,
      specialization,
      email: emailFromBody
    } = req.body;
    const userId = req.user.uid;

    const facultyData = cleanObject({
      userId,
      email: req.user.email || emailFromBody,
      name,
      employeeId,
      designation,
      department,
      specialization,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('faculty').doc(userId).set(facultyData, { merge: true });

    res.json({ success: true, faculty: facultyData });
  } catch (error) {
    console.error('Error creating faculty profile:', error);
    res.status(500).json({ error: 'Failed to create faculty profile' });
  }
});

// Create Course
app.post('/api/faculty/courses', verifyToken, async (req, res) => {
  try {
    const { code, name, credits, semester, department, academicYear } = req.body;
    const facultyId = req.user.uid;

    // Basic validation to give user-friendly 400 instead of 500
    if (!code || !name || !department) {
      return res.status(400).json({ error: 'Missing required fields: code, name, department' });
    }

    const courseData = cleanObject({
      code,
      name,
      credits, // optional
      semester,
      department,
      academicYear, // optional, used by guide
      facultyId,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const courseRef = await db.collection('courses').add(courseData);

    res.json({ success: true, courseId: courseRef.id, course: { id: courseRef.id, ...courseData } });
  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ error: 'Failed to create course' });
  }
});

// List Courses for faculty
app.get('/api/faculty/courses', verifyToken, async (req, res) => {
  try {
    const facultyId = req.user.uid;
    const snapshot = await db.collection('courses')
      .where('facultyId', '==', facultyId)
      .get();

    const courses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, courses });
  } catch (error) {
    console.error('Error listing courses:', error);
    res.status(500).json({ error: 'Failed to list courses' });
  }
});

// Create full class (course + timetable + roster import)
app.post('/api/faculty/classes/full', verifyToken, async (req, res) => {
  try {
    const facultyId = req.user.uid;
    const {
      branch, // department
      year, // academicYear
      courseName,
      courseCode,
      className,
      section = 'A',
      timetable = [], // Array<{ day, time, type, room? }>
      credits,
      semester,
      session
    } = req.body || {};

    if (!branch || !year || !courseName || !courseCode) {
      return res.status(400).json({ error: 'branch, year, courseName, courseCode are required' });
    }

    // Generate unique 6-character join code
    function generateJoinCode() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // removed confusing chars
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return code;
    }

    let joinCode = generateJoinCode();
    // Ensure uniqueness
    let existing = await db.collection('courses').where('joinCode', '==', joinCode).limit(1).get();
    while (!existing.empty) {
      joinCode = generateJoinCode();
      existing = await db.collection('courses').where('joinCode', '==', joinCode).limit(1).get();
    }

    // Create course with embedded timetable and join code
    const courseData = cleanObject({
      code: courseCode,
      name: courseName,
      department: branch,
      academicYear: year,
      className: className || `${branch}${year}`,
      section,
      joinCode,
      facultyId,
      isActive: true,
      timetable: Array.isArray(timetable) ? timetable : [],
      enrolledCount: 0,
      credits: credits || 3,
      semester: semester || '',
      session: session || 'Spring',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const courseRef = await db.collection('courses').add(courseData);

    const created = { id: courseRef.id, ...courseData };
    res.json({ success: true, course: created });
  } catch (error) {
    console.error('Error creating full class:', error);
    res.status(500).json({ error: 'Failed to create full class' });
  }
});

// Delete a course
app.delete('/api/faculty/courses/:courseId', verifyToken, async (req, res) => {
  try {
    const facultyId = req.user.uid;
    const { courseId } = req.params;

    if (!courseId) {
      return res.status(400).json({ error: 'courseId is required' });
    }

    // Check if course exists and belongs to faculty
    const courseDoc = await db.collection('courses').doc(courseId).get();

    if (!courseDoc.exists) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const courseData = courseDoc.data();
    if (courseData.facultyId !== facultyId) {
      return res.status(403).json({ error: 'Not authorized to delete this course' });
    }

    // Delete the course
    await db.collection('courses').doc(courseId).delete();

    const studentEmail = req.body.studentEmail || req.body.studentId || req.body.email;

    if (!courseId || !studentEmail) {
      return res.status(400).json({ error: 'courseId and student email are required' });
    }

    // Find student by email
    const studentSnapshot = await db.collection('students')
      .where('email', '==', studentEmail)
      .limit(1)
      .get();

    if (studentSnapshot.empty) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const studentDoc = studentSnapshot.docs[0];
    const studentId = studentDoc.id;

    // Check if already enrolled
    const existingEnrollment = await db.collection('enrollments')
      .where('studentId', '==', studentId)
      .where('courseId', '==', courseId)
      .limit(1)
      .get();

    if (!existingEnrollment.empty) {
      return res.status(400).json({ error: 'Student already enrolled' });
    }

    // Enroll student
    const enrollmentData = {
      studentId,
      courseId,
      isActive: true,
      enrolledAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('enrollments').add(enrollmentData);

    res.json({ success: true, message: 'Student enrolled successfully' });
  } catch (error) {
    console.error('Error enrolling student:', error);
    res.status(500).json({ error: 'Failed to enroll student' });
  }
});

// Generate QR Code for Session
app.post('/api/faculty/generate-qr', verifyToken, async (req, res) => {
  try {
    // Accept both old keys and the ones in the guide
    const courseId = req.body.courseId;
    const roomNumber = req.body.roomNumber;
    const location = req.body.location || {};
    const latitude = req.body.latitude ?? location.latitude;
    const longitude = req.body.longitude ?? location.longitude;
    const radius = req.body.radius ?? req.body.geofenceRadius ?? (location.radius ?? 50);
    const validitySeconds = req.body.validitySeconds ?? (req.body.expiresIn ? Number(req.body.expiresIn) : 300);
    const facultyId = req.user.uid;

    // Validate required inputs early with clear message
    if (!courseId) {
      return res.status(400).json({ error: 'courseId is required' });
    }
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'location.latitude and location.longitude are required' });
    }

    // Verify faculty teaches this course
    const courseDoc = await db.collection('courses').doc(courseId).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const course = courseDoc.data();
    if (course.facultyId !== facultyId) {
      return res.status(403).json({ error: 'You are not authorized to create sessions for this course' });
    }

    // Create session
    const sessionData = cleanObject({
      courseId,
      courseName: course.name,
      courseCode: course.code,
      facultyId,
      date: admin.firestore.Timestamp.now(),
      startTime: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      roomNumber,
      locationLatitude: latitude,
      locationLongitude: longitude,
      geofenceRadius: radius,
      presentCount: 0,
      totalStudents: 0,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const sessionRef = await db.collection('sessions').add(sessionData);
    const sessionId = sessionRef.id;

    // Generate QR payload
    const qrPayload = generateQRPayload(
      sessionId,
      courseId,
      facultyId,
      { latitude, longitude, radius },
      validitySeconds * 1000
    );

    // Store active QR
    await db.collection('activeQRs').doc(sessionId).set(cleanObject({
      ...qrPayload,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }));

    res.json({
      success: true,
      sessionId,
      qrData: JSON.stringify(cleanObject(qrPayload)),
      qrPayload: cleanObject(qrPayload),
      expiresIn: validitySeconds,
      session: { id: sessionId, ...sessionData }
    });

  } catch (error) {
    console.error('Error generating QR:', error);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Get Live Attendance for Session - OPTIMIZED
app.get('/api/faculty/session/:sessionId/attendance', verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Get session
    const sessionDoc = await db.collection('sessions').doc(sessionId).get();
    if (!sessionDoc.exists) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionDoc.data();

    // Get attendance records
    const attendanceSnapshot = await db.collection('attendance')
      .where('sessionId', '==', sessionId)
      .orderBy('markedAt', 'desc')
      .get();

    // OPTIMIZED: Use denormalized data (no additional student reads!)
    const attendees = attendanceSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        studentId: data.studentId,
        studentName: data.studentName || 'Unknown',  // Denormalized
        rollNo: data.studentRollNo || 'N/A',  // Denormalized
        status: data.status,
        markedAt: data.markedAt,
        distance: data.distanceFromClass
      };
    });

    res.json({
      session: { id: sessionDoc.id, ...session },
      attendees,
      presentCount: attendees.filter(a => a.status === 'present').length,
      totalAttendees: attendees.length
    });

  } catch (error) {
    console.error('Error fetching session attendance:', error);
    res.status(500).json({ error: 'Failed to fetch session attendance' });
  }
});

// Stop Session
app.post('/api/faculty/session/:sessionId/stop', verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.params;

    await db.collection('sessions').doc(sessionId).update({
      isActive: false,
      endedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('activeQRs').doc(sessionId).delete();

    res.json({ success: true, message: 'Session stopped successfully' });
  } catch (error) {
    console.error('Error stopping session:', error);
    res.status(500).json({ error: 'Failed to stop session' });
  }
});

// List enrolled students for a course (faculty view)
app.get('/api/faculty/course/:courseId/students', verifyToken, async (req, res) => {
  try {
    const { courseId } = req.params;
    const sessionId = req.query.sessionId; // optional: provide session to include present status

    // Verify requesting user is faculty for this course
    const courseDoc = await db.collection('courses').doc(courseId).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ error: 'Course not found' });
    }
    const course = courseDoc.data();
    if (course.facultyId !== req.user.uid) {
      return res.status(403).json({ error: 'Not authorized for this course' });
    }

    // Get enrollments
    const enrollmentsSnapshot = await db.collection('enrollments')
      .where('courseId', '==', courseId)
      .where('isActive', '==', true)
      .get();

    const studentIds = enrollmentsSnapshot.docs.map(d => d.data().studentId);
    const students = [];
    for (const sid of studentIds) {
      const sDoc = await db.collection('students').doc(sid).get();
      if (sDoc.exists) {
        students.push({ id: sid, ...sDoc.data() });
      }
    }

    let presentSet = new Set();
    if (sessionId) {
      const attendanceSnapshot = await db.collection('attendance')
        .where('sessionId', '==', sessionId)
        .where('status', '==', 'present')
        .get();
      presentSet = new Set(attendanceSnapshot.docs.map(d => d.data().studentId));
    }

    const result = students.map(s => ({
      id: s.id,
      name: s.name || 'Unknown',
      rollNo: s.rollNo || s.rollNumber || 'N/A',
      present: presentSet.has(s.id)
    }));

    res.json({ success: true, students: result });
  } catch (error) {
    console.error('Error listing enrolled students:', error);
    res.status(500).json({ error: 'Failed to list enrolled students' });
  }
});

// Manual attendance marking for a session
app.post('/api/faculty/session/:sessionId/manual-attendance', verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { presentStudentIds } = req.body; // array of student IDs marked present
    if (!Array.isArray(presentStudentIds)) {
      return res.status(400).json({ error: 'presentStudentIds must be an array' });
    }

    // Verify session exists and belongs to faculty
    const sessionDoc = await db.collection('sessions').doc(sessionId).get();
    if (!sessionDoc.exists) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = sessionDoc.data();
    if (session.facultyId !== req.user.uid) {
      return res.status(403).json({ error: 'Not authorized for this session' });
    }

    // Fetch current present attendees
    const currentSnapshot = await db.collection('attendance')
      .where('sessionId', '==', sessionId)
      .get();

    const currentPresentIds = new Set(
      currentSnapshot.docs
        .filter(d => d.data().status === 'present')
        .map(d => d.data().studentId)
    );

    // Determine adds and removals
    const newPresentSet = new Set(presentStudentIds);
    const toAdd = presentStudentIds.filter(id => !currentPresentIds.has(id));
    const toRemove = Array.from(currentPresentIds).filter(id => !newPresentSet.has(id));

    // Apply additions
    for (const studentId of toAdd) {
      await db.collection('attendance').add({
        sessionId,
        courseId: session.courseId,
        studentId,
        status: 'present',
        markedAt: admin.firestore.FieldValue.serverTimestamp(),
        markedBy: 'faculty',
        locationVerified: false,
        manual: true
      });
    }

    // Apply removals (mark as absent)
    for (const studentId of toRemove) {
      const existing = currentSnapshot.docs.find(d => d.data().studentId === studentId && d.data().status === 'present');
      if (existing) {
        await db.collection('attendance').doc(existing.id).update({
          status: 'absent',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          markedBy: 'faculty',
          manual: true
        });
      }
    }

    // Update presentCount delta
    const delta = toAdd.length - toRemove.length;
    if (delta !== 0) {
      await db.collection('sessions').doc(sessionId).update({
        presentCount: admin.firestore.FieldValue.increment(delta)
      });
    }

    res.json({ success: true, added: toAdd.length, removed: toRemove.length });
  } catch (error) {
    console.error('Error in manual attendance:', error);
    res.status(500).json({ error: 'Failed to save manual attendance' });
  }
});

// ============================================
// STUDENT JOIN COURSE BY CODE
// ============================================
app.post('/api/student/join-course', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { joinCode } = req.body;
    if (!joinCode) {
      return res.status(400).json({ error: 'joinCode is required' });
    }

    // Find course by join code
    const courseSnapshot = await db.collection('courses')
      .where('joinCode', '==', joinCode.toUpperCase())
      .limit(1)
      .get();
    if (courseSnapshot.empty) {
      return res.status(404).json({ error: 'Invalid join code' });
    }
    const courseDoc = courseSnapshot.docs[0];
    const courseId = courseDoc.id;

    // Check existing enrollment
    const existing = await db.collection('enrollments')
      .where('studentId', '==', userId)
      .where('courseId', '==', courseId)
      .limit(1)
      .get();
    if (!existing.empty) {
      return res.status(400).json({ error: 'Already enrolled in this course' });
    }

    // Create enrollment
    const enrollmentData = {
      studentId: userId,
      courseId,
      isActive: true,
      enrolledAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'join-code'
    };
    const enrRef = await db.collection('enrollments').add(enrollmentData);

    // Increment enrolledCount
    await db.collection('courses').doc(courseId).update({
      enrolledCount: admin.firestore.FieldValue.increment(1)
    });

    res.json({ success: true, enrollmentId: enrRef.id, course: { id: courseId, ...courseDoc.data() } });
  } catch (error) {
    console.error('Error joining course:', error);
    res.status(500).json({ error: 'Failed to join course' });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 IIIT NR Attendance Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📱 Network: http://192.168.137.1:${PORT}/health`);
});
