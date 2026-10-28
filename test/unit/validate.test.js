import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIdentifier, normalizePhone, validateProfile } from '../../validate.js';

test('parses emails and Nigerian phone numbers', () => {
  assert.deepEqual(parseIdentifier(' Ada@Example.COM '), { type: 'email', value: 'ada@example.com' });
  assert.deepEqual(parseIdentifier('0803 123 4567'), { type: 'phone', value: '+2348031234567' });
  assert.equal(normalizePhone('+234 803-123-4567'), '+2348031234567');
  for (const typed of ['08031234567', '803 123 4567', '+234 803 123 4567', '2348031234567', '+234 0803 123 4567', '00234 803 123 4567', '(0803) 123-4567']) {
    assert.equal(normalizePhone(typed), '+2348031234567', typed);
  }
  for (const bad of ['0603 123 4567', '803 123 456', '+44 7911 123456', '0803 123 45678']) assert.equal(normalizePhone(bad), null, bad);
  assert.equal(parseIdentifier('12345'), null);
  assert.equal(parseIdentifier('not-an-email@'), null);
});

test('profile rules', () => {
  const ok = validateProfile({ full_name: 'Ada Obi', state: 'Lagos', lga: 'Ikeja', consent: true, interests: ['Social media', 'bogus'] });
  assert.equal(ok.profile.interests, 'Social media');
  const bad = validateProfile({ full_name: 'Ada', state: 'Atlantis', lga: '', date_of_birth: '2020-01-01' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['consent', 'date_of_birth', 'full_name', 'lga', 'state']);
  assert.ok(validateProfile({ full_name: 'Ada Obi', state: 'Lagos', lga: 'Ikeja' }, { requireConsent: false }).profile);
});
