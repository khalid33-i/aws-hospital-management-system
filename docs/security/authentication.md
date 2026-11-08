# Authentication and authorization

## Authentication vs authorization

| | Authentication (AuthN) | Authorization (AuthZ) |
|---|---|---|
| Question | Who are you? | What are you allowed to do? |
| الفكرة | إثبات الهوية (إيميل + باسورد) | تحديد الصلاحيات حسب الدور |
| In this project | `POST /api/auth/login` checks the bcrypt hash and issues a JWT | `authorize('Doctor')` etc. plus per-record checks (`patient_id = me`) |
| Failure | `401 Unauthorized` | `403 Forbidden` (or `404` for someone else's record) |

## How the JWT works

A JWT is three base64url parts: `header.payload.signature`. The payload holds `sub` (user id), `role`, `iss`, `exp`. The server signs header+payload with `JWT_SECRET` (HMAC-SHA256). Anyone can *read* the payload, but nobody can *change* it without the secret, because the signature would no longer match. On every request the server recomputes the signature and checks `exp`. التوقيع هو اللي يحمي التوكن من التعديل، مو التشفير.

Flow in this app:

1. `POST /api/auth/login` with email + password.
2. Server loads the user, runs `bcrypt.compare` (also when the email does not exist, to keep timing equal), checks `is_active`.
3. Server signs a JWT valid for `JWT_EXPIRES_MINUTES` (default 60) and sets it in an **HttpOnly, SameSite=Strict** cookie (`Secure` when `COOKIE_SECURE=true`).
4. The browser sends the cookie automatically. `authenticate` middleware verifies the token, then **reloads the user and role from the database**.
5. `authorize(...roles)` checks that database role. Logout clears the cookie.

## Design decisions

- **The role in the token is ignored.** The role always comes from the database, so deactivating an account or changing a role takes effect on the very next request, not when the token expires. A test forges a token claiming `Admin` for a patient and gets `403`.
- **HttpOnly cookie, not localStorage.** JavaScript (including injected scripts) cannot read the token. `SameSite=Strict` stops other sites from making authenticated requests (CSRF).
- **Algorithm pinned** to HS256 and issuer checked; `alg: none` and tokens signed with another key are rejected.
- **Generic login error.** Wrong password, unknown email and inactive account all return the same message, so accounts cannot be enumerated.
- **Rate limiting.** Failed logins are limited to 10 per 15 minutes per IP (`LOGIN_RATE_LIMIT`).
- **Password policy.** At least 10 characters with upper case, lower case and a digit. bcrypt, 12 rounds.
- **Frontend checks are cosmetic.** Hiding menu items is convenience only; every route is protected by middleware on the server.
- **Row-level scoping.** Patients, doctors and the pharmacist API only query rows tied to the signed-in account's own profile id (taken from the session, never from the URL or body). Someone else's record answers `404`, exactly like a record that does not exist.
- **SQL injection.** Every query uses placeholders (`?`); user input is never concatenated into SQL. LIKE wildcards in search terms are escaped.
- **Input validation.** Every request body, query and URL parameter is parsed with zod; unknown fields are dropped, so a client cannot write columns such as `is_active` or `role_id`.
- **Audit log.** Logins, failed logins, user changes, prescription views, dispensing and stock changes are written to `audit_logs`. Dispensing writes its audit row inside the same transaction.

## Role permissions

| Role | Can | Cannot |
|---|---|---|
| Admin | Users, departments, specialties, settings, audit log, hospital and pharmacy statistics | Read prescriptions, patient medical records or batch-level stock |
| Doctor | Own schedule, assigned patients' records, write and cancel own pending prescriptions, update own appointment status | See stock or prices, other doctors' patients, pharmacy functions |
| Receptionist | Register and edit patients, book / move / cancel appointments | Medical records, prescriptions, pharmacy |
| Pharmacist | Medications, inventory batches, view prescriptions, dispense, dispensing history | Edit or delete prescriptions (no such endpoint exists) |
| Patient | Own profile (contact details only), own appointments, prescriptions and visits | Anyone else's data |

## Not claimed

This is an educational project with fictional data. It is **not** HIPAA-compliant and not a certified clinical system.
