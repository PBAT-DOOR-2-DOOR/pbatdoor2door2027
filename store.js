// Data layer (Postgres). Schema lives in migrations/*.sql.
//
// Members sign in with an email OR a phone number. A contact is "verified" once the
// person has entered a code sent to it; only verified contacts can be used to log in,
// and each verified email/phone belongs to at most one member.

// Profile questions asked after the first login (all stored as text).
export const PROFILE_FIELDS = [
  'full_name', 'gender', 'date_of_birth', 'state', 'lga', 'ward',
  'polling_unit', 'address', 'occupation', 'interests',
];

const MEMBER_COLS = `id, email, email_verified, phone, phone_verified, ${PROFILE_FIELDS.join(', ')}, consent_at, join_consent_at, sms_consent_at, created_at`;

const QUERIES = {
  getCode: 'SELECT * FROM otp_codes WHERE identifier = $1',
  upsertCode: `INSERT INTO otp_codes (identifier, channel, code_hash, expires_at, attempts, sent_at)
               VALUES ($1, $2, $3, $4, 0, $5)
               ON CONFLICT (identifier) DO UPDATE SET channel = EXCLUDED.channel, code_hash = EXCLUDED.code_hash,
                 expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at`,
  bumpAttempts: 'UPDATE otp_codes SET attempts = attempts + 1 WHERE identifier = $1',
  deleteCode: 'DELETE FROM otp_codes WHERE identifier = $1',
  purgeCodes: 'DELETE FROM otp_codes WHERE expires_at < $1',

  memberByVerifiedEmail: `SELECT ${MEMBER_COLS} FROM members WHERE email = $1 AND email_verified = 1`,
  memberByVerifiedPhone: `SELECT ${MEMBER_COLS} FROM members WHERE phone = $1 AND phone_verified = 1`,
  memberById: `SELECT ${MEMBER_COLS} FROM members WHERE id = $1`,
  memberByIdForUpdate: `SELECT ${MEMBER_COLS} FROM members WHERE id = $1 FOR UPDATE`,
  // When someone proves they own a contact, remove it from any account that only typed it in.
  releaseUnverifiedEmail: 'UPDATE members SET email = NULL WHERE email = $1 AND email_verified = 0',
  releaseUnverifiedPhone: 'UPDATE members SET phone = NULL WHERE phone = $1 AND phone_verified = 0',
  insertByEmail: `INSERT INTO members (email, email_verified, created_at) VALUES ($1, 1, $2) RETURNING ${MEMBER_COLS}`,
  insertByPhone: `INSERT INTO members (phone, phone_verified, created_at) VALUES ($1, 1, $2) RETURNING ${MEMBER_COLS}`,
  setEmail: 'UPDATE members SET email = $2, email_verified = 0 WHERE id = $1 AND email_verified = 0',
  setPhone: 'UPDATE members SET phone = $2, phone_verified = 0 WHERE id = $1 AND phone_verified = 0',
  linkEmail: 'UPDATE members SET email = $2, email_verified = 1 WHERE id = $1',
  linkPhone: 'UPDATE members SET phone = $2, phone_verified = 1 WHERE id = $1',
  moveSessions: 'UPDATE member_sessions SET member_id = $2 WHERE member_id = $1',
  deleteMember: 'DELETE FROM members WHERE id = $1',
  mergeInto: `UPDATE members SET email = $2, email_verified = $3, phone = $4, phone_verified = $5,
                ${PROFILE_FIELDS.map((f, i) => `${f} = $${i + 6}`).join(', ')},
                consent_at = $${PROFILE_FIELDS.length + 6},
                join_consent_at = $${PROFILE_FIELDS.length + 7},
                sms_consent_at = $${PROFILE_FIELDS.length + 8},
                created_at = $${PROFILE_FIELDS.length + 9} WHERE id = $1`,
  updateProfile: `UPDATE members SET ${PROFILE_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ')},
                    consent_at = COALESCE(consent_at, $${PROFILE_FIELDS.length + 2}) WHERE id = $1`,
  recordConsent: `UPDATE members SET join_consent_at = COALESCE(join_consent_at, $2),
                    sms_consent_at = CASE WHEN $3 = 1 THEN COALESCE(sms_consent_at, $2) ELSE sms_consent_at END
                    WHERE id = $1`,

  insertSession: `INSERT INTO member_sessions (token_hash, member_id, created_at, last_seen, user_agent)
                  VALUES ($1, $2, $3, $4, $5)`,
  getSession: 'SELECT token_hash, member_id, last_seen FROM member_sessions WHERE token_hash = $1',
  touchSession: 'UPDATE member_sessions SET last_seen = $1 WHERE token_hash = $2',
  listSessions: `SELECT token_hash, created_at, last_seen, user_agent FROM member_sessions
                  WHERE member_id = $1 ORDER BY last_seen DESC`,
  deleteSession: 'DELETE FROM member_sessions WHERE token_hash = $1',
  deleteMemberSessions: 'DELETE FROM member_sessions WHERE member_id = $1',

  // Serialises concurrent requests for the same bucket so the count can't be overshot.
  lockBucket: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
  countHits: 'SELECT count(*)::int AS n FROM rate_limit_hits WHERE bucket = $1 AND hit_at > $2',
  insertHit: 'INSERT INTO rate_limit_hits (bucket, hit_at) VALUES ($1, $2)',
  purgeHits: 'DELETE FROM rate_limit_hits WHERE hit_at < $1',

  // Volunteer area: visits and pledges copied onto the keeper when two accounts merge.
  moveVisits: `UPDATE visits SET member_id = $2 WHERE member_id = $1
               AND NOT EXISTS (SELECT 1 FROM visits v2 WHERE v2.client_id = visits.client_id AND v2.member_id = $2)`,
  movePledges: `UPDATE pledges SET member_id = $2 WHERE member_id = $1
                AND NOT EXISTS (SELECT 1 FROM pledges p2 WHERE p2.client_id = pledges.client_id AND p2.member_id = $2)`,
  moveRole: `UPDATE roles SET member_id = $2 WHERE member_id = $1
             AND NOT EXISTS (SELECT 1 FROM roles r2 WHERE r2.member_id = $2)`,

  insertVisit: `INSERT INTO visits (member_id, client_id, visit_date, households, people, area, notes, state, lga, ward, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (client_id) DO NOTHING`,
  insertPledge: `INSERT INTO pledges (member_id, client_id, full_name, phone, polling_unit, note, consent_at, state, lga, ward, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (client_id) DO NOTHING`,
  myVisits: `SELECT client_id, visit_date, households, people, area, notes, created_at FROM visits
             WHERE member_id = $1 ORDER BY visit_date DESC, created_at DESC LIMIT 20`,
  myPledges: `SELECT client_id, full_name, polling_unit, created_at FROM pledges WHERE member_id = $1 ORDER BY created_at DESC LIMIT 20`,
  myTotals: `SELECT (SELECT COUNT(*)::int FROM visits WHERE member_id = $1) AS visits,
                    (SELECT COALESCE(SUM(households), 0)::int FROM visits WHERE member_id = $1) AS households,
                    (SELECT COALESCE(SUM(people), 0)::int FROM visits WHERE member_id = $1) AS people,
                    (SELECT COUNT(*)::int FROM pledges WHERE member_id = $1) AS pledges`,
  areaCounts: `SELECT
      (SELECT COUNT(*)::int FROM members WHERE consent_at IS NOT NULL AND state = $1 AND lga = $2 AND ward = $3 AND polling_unit = $4 AND polling_unit <> '') AS pu_count,
      (SELECT COUNT(*)::int FROM members WHERE consent_at IS NOT NULL AND state = $1 AND lga = $2 AND ward = $3 AND ward <> '') AS ward_count,
      (SELECT COUNT(*)::int FROM members WHERE consent_at IS NOT NULL AND state = $1 AND lga = $2 AND lga <> '') AS lga_count,
      (SELECT COUNT(*)::int FROM members WHERE consent_at IS NOT NULL AND state = $1 AND state <> '') AS state_count`,
  wardActivity: `SELECT COALESCE(SUM(households), 0)::int AS households, COUNT(*)::int AS visits FROM visits
                 WHERE state = $1 AND lga = $2 AND ward = $3 AND created_at >= $4`,
  wardPledges: 'SELECT COUNT(*)::int AS pledges FROM pledges WHERE state = $1 AND lga = $2 AND ward = $3',
  stateCoordinators: `SELECT m.full_name FROM roles r JOIN members m ON m.id = r.member_id
                      WHERE r.role = 'state' AND r.state = $1 ORDER BY m.full_name`,
  topVolunteers: `SELECT m.id, m.full_name, m.state, m.ward, SUM(v.households)::int AS households, COUNT(*)::int AS visits
                  FROM visits v JOIN members m ON m.id = v.member_id
                  WHERE v.created_at >= $1 AND ($2 = '' OR v.state = $2) AND ($3 = '' OR v.lga = $3) AND ($4 = '' OR v.ward = $4)
                  GROUP BY m.id, m.full_name, m.state, m.ward ORDER BY households DESC, visits DESC LIMIT 20`,
  topStates: `SELECT state, SUM(households)::int AS households, COUNT(*)::int AS visits, COUNT(DISTINCT member_id)::int AS volunteers
              FROM visits WHERE created_at >= $1 AND state <> '' GROUP BY state ORDER BY households DESC LIMIT 37`,

  getRole: 'SELECT member_id, role, state FROM roles WHERE member_id = $1',
  setRole: `INSERT INTO roles (member_id, role, state, assigned_by, assigned_at) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (member_id) DO UPDATE SET role = EXCLUDED.role, state = EXCLUDED.state,
              assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at`,
  deleteRole: 'DELETE FROM roles WHERE member_id = $1',
  listRoles: `SELECT r.member_id, r.role, r.state, r.assigned_at, m.full_name, m.email, m.phone FROM roles r
              JOIN members m ON m.id = r.member_id ORDER BY r.role, r.state, m.full_name`,
  coordVolunteers: `SELECT m.id, m.full_name, m.email, m.phone, m.gender, m.state, m.lga, m.ward, m.polling_unit, m.occupation,
                      m.interests, m.sms_consent_at, m.created_at,
                      (SELECT COUNT(*)::int FROM visits v WHERE v.member_id = m.id) AS visits,
                      (SELECT COALESCE(SUM(households), 0)::int FROM visits v WHERE v.member_id = m.id) AS households,
                      (SELECT COUNT(*)::int FROM pledges p WHERE p.member_id = m.id) AS pledges
                    FROM members m WHERE m.consent_at IS NOT NULL AND ($1 = '' OR m.state = $1)
                    ORDER BY m.state, m.lga, m.ward, m.full_name LIMIT 5000`,
  coordPledges: `SELECT p.full_name, p.phone, p.polling_unit, p.note, p.state, p.lga, p.ward, p.created_at, m.full_name AS volunteer
                 FROM pledges p JOIN members m ON m.id = p.member_id WHERE ($1 = '' OR p.state = $1)
                 ORDER BY p.created_at DESC LIMIT 5000`,
  coordByLgaMembers: `SELECT lga, COUNT(*)::int AS volunteers FROM members WHERE consent_at IS NOT NULL AND ($1 = '' OR state = $1)
                      GROUP BY lga`,
  coordByLgaVisits: `SELECT lga, COUNT(*)::int AS visits, COALESCE(SUM(households), 0)::int AS households FROM visits
                     WHERE ($1 = '' OR state = $1) AND created_at >= $2 GROUP BY lga`,
  coordByLgaPledges: `SELECT lga, COUNT(*)::int AS pledges FROM pledges WHERE ($1 = '' OR state = $1) GROUP BY lga`,
};

// BIGINT comes back from pg as a string; turn numeric columns back into numbers.
const NUMERIC = new Set(['id', 'member_id', 'created_at', 'expires_at', 'sent_at', 'last_seen', 'attempts',
  'consent_at', 'join_consent_at', 'sms_consent_at', 'email_verified', 'phone_verified',
  'visits', 'households', 'people', 'pledges', 'volunteers', 'pu_count', 'ward_count', 'lga_count',
  'state_count', 'assigned_at', 'assigned_by']);
const fixRow = (r) => {
  for (const k of Object.keys(r)) if (NUMERIC.has(k) && r[k] != null) r[k] = Number(r[k]);
  return r;
};

export function createStore(pool) {
  const q = async (name, params = [], db = pool) => (await db.query(QUERIES[name], params)).rows.map(fixRow);
  const one = async (name, params, db) => (await q(name, params, db))[0];
  const byVerified = (type, value, db) =>
    one(type === 'email' ? 'memberByVerifiedEmail' : 'memberByVerifiedPhone', [value], db);

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    ping: () => pool.query('SELECT 1'),

    getCode: (id) => one('getCode', [id]),
    upsertCode: (id, channel, hash, expiresAt, sentAt) => q('upsertCode', [id, channel, hash, expiresAt, sentAt]),
    bumpAttempts: (id) => q('bumpAttempts', [id]),
    deleteCode: (id) => q('deleteCode', [id]),
    purgeCodes: (now) => q('purgeCodes', [now]),

    memberById: (id) => one('memberById', [id]),
    memberByVerified: (type, value) => byVerified(type, value),

    /**
     * Sliding-window limiter: records a hit and returns true if `bucket` has had fewer than
     * `limit` hits in the last `windowMs`; otherwise returns false without recording one.
     */
    hit: (bucket, limit, windowMs, now = Date.now()) => tx(async (c) => {
      await c.query(QUERIES.lockBucket, [bucket]);
      const { n } = await one('countHits', [bucket, now - windowMs], c);
      if (n >= limit) return false;
      await q('insertHit', [bucket, now], c);
      return true;
    }),
    purgeHits: (before) => q('purgeHits', [before]),

    /** The person proved they own this email/phone: return their member, creating one if new. */
    async signInWith(type, value, now) {
      const existing = await byVerified(type, value);
      if (existing) return { member: existing, isNew: false };
      try {
        const member = await tx(async (c) => {
          await q(type === 'email' ? 'releaseUnverifiedEmail' : 'releaseUnverifiedPhone', [value], c);
          return one(type === 'email' ? 'insertByEmail' : 'insertByPhone', [value, now], c);
        });
        return { member, isNew: true };
      } catch (err) {
        // Two sign-ins racing for the same new contact: the other one won, use it.
        if (err.code !== '23505') throw err;
        const winner = await byVerified(type, value);
        if (winner) return { member: winner, isNew: false };
        throw err;
      }
    },

    /** Store a contact the member typed in (not verified yet). Returns false if someone else has it verified. */
    async setContact(memberId, type, value) {
      if (value != null) {
        const owner = await byVerified(type, value);
        if (owner && owner.id !== memberId) return false;
        if (owner && owner.id === memberId) return true;
      }
      await q(type === 'email' ? 'setEmail' : 'setPhone', [memberId, value]);
      return true;
    },

    /**
     * The member proved they own this email/phone. Attach it to their account; if another account
     * already signs in with it, merge the two (the older account is kept, sessions move with it).
     * Runs in one transaction so a failure part-way can't lose either account.
     */
    linkContact: (memberId, type, value) => tx(async (c) => {
      const owner = await byVerified(type, value, c);
      if (owner && owner.id === memberId) return { memberId, merged: false };
      if (!owner) {
        await q(type === 'email' ? 'releaseUnverifiedEmail' : 'releaseUnverifiedPhone', [value], c);
        await q(type === 'email' ? 'linkEmail' : 'linkPhone', [memberId, value], c);
        return { memberId, merged: false };
      }
      // Lock both rows in id order so two merges of the same pair can't deadlock.
      const [lo, hi] = [owner.id, memberId].sort((a, b) => a - b);
      const first = await one('memberByIdForUpdate', [lo], c);
      const second = await one('memberByIdForUpdate', [hi], c);
      if (!first || !second) return { conflict: true };
      const [keep, drop] = [first, second];          // the older (lower id) account is kept
      const pick = (t) => {
        const a = keep[`${t}_verified`] ? keep[t] : null, b = drop[`${t}_verified`] ? drop[t] : null;
        if (a && b && a !== b) return null;                      // two different verified contacts: can't merge
        return a || b ? [a || b, 1] : [keep[t] || drop[t] || null, 0];
      };
      const email = pick('email'), phone = pick('phone');
      if (!email || !phone) return { conflict: true };
      const consents = [keep.consent_at, drop.consent_at].filter((x) => x != null);
      const joinConsents = [keep.join_consent_at, drop.join_consent_at].filter((x) => x != null);
      const smsConsents = [keep.sms_consent_at, drop.sms_consent_at].filter((x) => x != null);
      await q('moveSessions', [drop.id, keep.id], c);
      await q('moveVisits', [drop.id, keep.id], c);
      await q('movePledges', [drop.id, keep.id], c);
      await q('moveRole', [drop.id, keep.id], c);
      await q('deleteMember', [drop.id], c);                    // frees its verified contacts for the keeper
      await q('mergeInto', [keep.id, email[0], email[1], phone[0], phone[1],
        ...PROFILE_FIELDS.map((f) => keep[f] || drop[f] || ''),
        consents.length ? Math.min(...consents) : null,
        joinConsents.length ? Math.min(...joinConsents) : null,
        smsConsents.length ? Math.min(...smsConsents) : null,
        Math.min(keep.created_at, drop.created_at)], c);
      return { memberId: keep.id, merged: true };
    }),

    recordConsent: (id, now, sms) => q('recordConsent', [id, now, sms ? 1 : 0]),

    updateProfile: (id, profile, now) =>
      q('updateProfile', [id, ...PROFILE_FIELDS.map((f) => profile[f] ?? ''), now]),

    insertSession: (hash, memberId, now, ua) => q('insertSession', [hash, memberId, now, now, ua]),
    getSession: (hash) => one('getSession', [hash]),
    touchSession: (hash, now) => q('touchSession', [now, hash]),
    listSessions: (memberId) => q('listSessions', [memberId]),
    deleteSession: (hash) => q('deleteSession', [hash]),
    deleteMemberSessions: (memberId) => q('deleteMemberSessions', [memberId]),

    insertVisit: (m, v, now) => q('insertVisit', [m.id, v.clientId, v.date, v.households, v.people, v.area, v.notes,
      m.state || '', m.lga || '', m.ward || '', now]),
    insertPledge: (m, p, now) => q('insertPledge', [m.id, p.clientId, p.name, p.phone, p.pollingUnit, p.note, now,
      m.state || '', m.lga || '', m.ward || '', now]),
    myVisits: (id) => q('myVisits', [id]),
    myPledges: (id) => q('myPledges', [id]),
    myTotals: (id) => one('myTotals', [id]),
    areaCounts: (m) => one('areaCounts', [m.state || '', m.lga || '', m.ward || '', m.polling_unit || '']),
    wardActivity: (m, since) => one('wardActivity', [m.state || '', m.lga || '', m.ward || '', since]),
    wardPledges: (m) => one('wardPledges', [m.state || '', m.lga || '', m.ward || '']),
    stateCoordinators: (state) => q('stateCoordinators', [state]),
    topVolunteers: (since, state = '', lga = '', ward = '') => q('topVolunteers', [since, state, lga, ward]),
    topStates: (since) => q('topStates', [since]),

    getRole: (id) => one('getRole', [id]),
    setRole: (id, role, state, by, now) => q('setRole', [id, role, state, by, now]),
    deleteRole: (id) => q('deleteRole', [id]),
    listRoles: () => q('listRoles'),
    coordVolunteers: (state) => q('coordVolunteers', [state]),
    coordPledges: (state) => q('coordPledges', [state]),
    async coordByLga(state, since) {
      const rows = new Map();
      const add = (list) => list.forEach((r) => rows.set(r.lga, {
        lga: r.lga, volunteers: 0, visits: 0, households: 0, pledges: 0, ...rows.get(r.lga), ...r,
      }));
      add(await q('coordByLgaMembers', [state]));
      add(await q('coordByLgaVisits', [state, since]));
      add(await q('coordByLgaPledges', [state]));
      return [...rows.values()].sort((a, b) => b.volunteers - a.volunteers || String(a.lga).localeCompare(String(b.lga)));
    },
  };
}
