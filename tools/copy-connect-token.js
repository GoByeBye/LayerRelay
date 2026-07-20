void (() => {
  'use strict';

  const expectedOrigin = 'https://connect.prusa3d.com';
  const tokenKey = 'auth.refresh_token';

  if (location.origin !== expectedOrigin) {
    console.error(`Token not shown: open ${expectedOrigin}/ and run this there.`);
    return;
  }

  let token;
  try {
    token = localStorage.getItem(tokenKey);
  } catch {
    console.error('Token not shown: this browser blocked access to Connect Local Storage.');
    return;
  }

  if (typeof token !== 'string' || token.length === 0) {
    console.error('Token not shown: sign in to Prusa Connect, then try again.');
    return;
  }

  console.info(
    'Copy the Prusa Connect refresh token printed on the next line. Treat it as a password.',
  );
  console.log(token);
  console.info(
    'After pasting it into the hidden setup prompt, clear this console and your clipboard, then close the private window.',
  );
})();
