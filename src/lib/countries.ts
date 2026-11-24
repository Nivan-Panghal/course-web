// src/lib/countries.ts
// Countries offered on the enroll popup and the workshop registration form.
// `length` = digits of the mobile number WITHOUT the country code.
// The stored phone is country code + number, except India, which is stored as the bare 10 digits
// (see src/lib/phone.ts).
//
// Singapore is deliberately absent: +65 plus 8 digits is 10 digits, which looks exactly like an
// Indian number once stored, and the WhatsApp bot would send it as an Indian number.
export const COUNTRIES = [
  { name: 'India', code: '+91', flag: '🇮🇳', length: 10 },
  { name: 'United States', code: '+1', flag: '🇺🇸', length: 10 },
  { name: 'United Kingdom', code: '+44', flag: '🇬🇧', length: 10 },
  { name: 'United Arab Emirates', code: '+971', flag: '🇦🇪', length: 9 },
  { name: 'Australia', code: '+61', flag: '🇦🇺', length: 9 },
  { name: 'Canada', code: '+1', flag: '🇨🇦', length: 10 },
  { name: 'Germany', code: '+49', flag: '🇩🇪', length: 11 },
  { name: 'France', code: '+33', flag: '🇫🇷', length: 9 },
  { name: 'Saudi Arabia', code: '+966', flag: '🇸🇦', length: 9 },
  { name: 'Pakistan', code: '+92', flag: '🇵🇰', length: 10 },
  { name: 'Bangladesh', code: '+880', flag: '🇧🇩', length: 10 },
  { name: 'Nepal', code: '+977', flag: '🇳🇵', length: 10 },
  { name: 'Sri Lanka', code: '+94', flag: '🇱🇰', length: 9 },
]