-- GoHospital schema (Cloudflare D1 / SQLite)
CREATE TABLE hospitals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'general',          -- teaching | general | specialist | clinic | maternity | primary
  ownership TEXT NOT NULL DEFAULT 'private',     -- public | private | mission | ngo
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  needs_review INTEGER NOT NULL DEFAULT 0,
  address TEXT,
  area TEXT,
  city TEXT NOT NULL DEFAULT 'Port Harcourt',
  state TEXT NOT NULL DEFAULT 'Rivers',
  lat REAL,
  lng REAL,
  phone TEXT,
  emergency_phone TEXT,
  email TEXT,
  website TEXT,
  description TEXT,
  hours TEXT,
  emergency_24h INTEGER NOT NULL DEFAULT 0,
  open_24h INTEGER NOT NULL DEFAULT 0,
  ambulance INTEGER NOT NULL DEFAULT 0,
  accepts_insurance INTEGER NOT NULL DEFAULT 0,
  insurance_notes TEXT,
  beds_total INTEGER,
  icu_total INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_hospitals_status ON hospitals(status);
CREATE INDEX idx_hospitals_area ON hospitals(area);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','hospital')),
  hospital_id INTEGER REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE INDEX idx_users_hospital ON users(hospital_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE specialties (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('specialty','capability')),
  keywords TEXT NOT NULL DEFAULT '',             -- comma separated symptoms / search terms
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE hospital_specialties (
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  code TEXT NOT NULL REFERENCES specialties(code) ON DELETE CASCADE,
  on_call INTEGER NOT NULL DEFAULT 0,            -- specialist available right now (live)
  PRIMARY KEY (hospital_id, code)
);

-- Latest live situation of each hospital
CREATE TABLE hospital_status (
  hospital_id INTEGER PRIMARY KEY REFERENCES hospitals(id) ON DELETE CASCADE,
  er_status TEXT NOT NULL CHECK (er_status IN ('open','busy','diversion','closed')),
  er_wait_minutes INTEGER,
  beds_available INTEGER,
  icu_available INTEGER,
  ambulance_ready INTEGER,
  notes TEXT,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER
);

CREATE TABLE status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  user_id INTEGER,
  er_status TEXT NOT NULL,
  er_wait_minutes INTEGER,
  beds_available INTEGER,
  icu_available INTEGER,
  ambulance_ready INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_status_log_h ON status_log(hospital_id, created_at DESC);

CREATE TABLE contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  handled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- Reference data: specialties and capabilities (symptom keywords power the search)
INSERT INTO specialties (code,label,kind,keywords,description,sort) VALUES
('cardiology','Heart','specialty','chest pain,heart,heart attack,palpitations,blood pressure,hypertension,cardiac,breathless,shortness of breath','Cardiology units, cardiac emergency care',10),
('maternal','Pregnancy & birth','specialty','pregnant,pregnancy,labour,labor,delivery,antenatal,caesarean,c-section,miscarriage,obstetrics,gynaecology,gynecology,birth,postnatal,bleeding in pregnancy','Labour ward, obstetrics and gynaecology',20),
('trauma','Accident & injury','specialty','accident,injury,wound,gunshot,burn,burns,road crash,fracture,bleeding,cut,emergency','Trauma and emergency surgery',30),
('pediatric','Child health','specialty','child,children,baby,infant,newborn,paediatric,pediatric,fever in child,convulsion in child','Paediatric wards and specialists',40),
('orthopedic','Bones & joints','specialty','broken bone,bone,fracture,joint,knee,back pain,spine,orthopaedic,orthopedic,physiotherapy','Orthopaedics and fracture care',50),
('oncology','Cancer','specialty','cancer,tumour,tumor,chemotherapy,radiotherapy,lump,oncology,screening','Cancer treatment and screening',60),
('neurology','Brain & nerves','specialty','stroke,seizure,epilepsy,fits,headache,migraine,numbness,paralysis,neurology,brain','Neurology and neurosurgery',70),
('general','General medicine','specialty','fever,malaria,typhoid,cough,cold,stomach pain,diarrhoea,diarrhea,vomiting,general,checkup,check-up','Family and internal medicine',80),
('surgery','General surgery','specialty','surgery,appendix,appendicitis,hernia,swelling,abscess,operation','General and emergency surgery',90),
('kidney','Kidney & dialysis','specialty','kidney,dialysis,urine,renal,urology,prostate,stones','Nephrology, urology and dialysis',100),
('diabetes','Diabetes & endocrine','specialty','diabetes,sugar,thyroid,endocrine,insulin','Diabetes and hormone care',110),
('eye','Eye care','specialty','eye,vision,cataract,glaucoma,ophthalmology,sight','Ophthalmology',120),
('ent','Ear, nose & throat','specialty','ear,nose,throat,tonsil,sinus,hearing,ent','ENT surgery and care',130),
('dental','Dental','specialty','tooth,teeth,dental,dentist,gum,toothache','Dental care',140),
('mental','Mental health','specialty','depression,anxiety,mental,psychiatry,psychiatric,addiction,counselling','Psychiatry and counselling',150),
('infectious','Infectious disease','specialty','hiv,tuberculosis,tb,hepatitis,infection,lassa,cholera,covid','Infectious disease and HIV care',160),
('skin','Skin','specialty','skin,rash,eczema,dermatology,acne','Dermatology',170),
('icu','Intensive care (ICU)','capability','icu,intensive care,critical care,ventilator','',200),
('nicu','Newborn ICU (NICU)','capability','nicu,newborn icu,incubator,premature','',210),
('theatre','Operating theatre','capability','theatre,operating,surgery','',220),
('blood_bank','Blood bank','capability','blood,transfusion,blood bank','',230),
('ct','CT scan','capability','ct,ct scan,scan','',240),
('mri','MRI','capability','mri,scan','',250),
('xray','X-ray','capability','x-ray,xray','',260),
('ultrasound','Ultrasound','capability','ultrasound,scan','',270),
('lab','Laboratory','capability','lab,laboratory,test,tests','',280),
('dialysis','Dialysis unit','capability','dialysis','',290),
('cath_lab','Cath lab','capability','cath lab,angiogram','',300),
('oxygen','Oxygen supply','capability','oxygen','',310),
('pharmacy','24-hour pharmacy','capability','pharmacy,drugs,medicine','',320),
('maternity','Maternity ward','capability','maternity,labour ward','',330);
