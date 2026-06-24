// CloudFront viewer-request function for the DEFAULT behavior (user content).
//
// Attach this ONLY to the default behavior. It must never run on the
// /login, /admin, /upload, /app/* or /status/* behaviors — uppercasing those
// paths would break them.
//
// Cascade:
//   1. "/"                         -> 302 redirect to /login (admin entry).
//   2. uppercase the first path segment (the UID) so mixed/lowercase share
//      links resolve to the canonical uppercase S3 keys.
//   3. last segment has a "."      -> concrete asset (e.g. /UID/assets/x.png),
//                                     pass through with only the UID uppercased.
//   4. exactly /<uid> or /<uid>/   -> rewrite to /<uid>/index.html.
//   5. anything else               -> pass through with the UID uppercased.
//
// Written in ES5 style for the CloudFront Functions runtime.
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // 1. Root goes to the admin login page.
  if (uri === '/' || uri === '') {
    return {
      statusCode: 302,
      statusDescription: 'Found',
      headers: { location: { value: '/login' } },
    };
  }

  // 2. Uppercase the first path segment (the UID). uri begins with '/', so
  //    parts[0] is always the empty string and parts[1] is the UID.
  var parts = uri.split('/');
  if (parts.length > 1 && parts[1]) {
    parts[1] = parts[1].toUpperCase();
    uri = parts.join('/');
  }

  // 3. A file extension in the last segment means it's a real asset request.
  var lastSlash = uri.lastIndexOf('/');
  var lastSegment = uri.substring(lastSlash + 1);
  if (lastSegment.indexOf('.') !== -1) {
    request.uri = uri;
    return request;
  }

  // 4. Exactly /<uid> (length 2) or /<uid>/ (length 3 + empty tail).
  if (parts.length === 2 || (parts.length === 3 && parts[2] === '')) {
    request.uri = '/' + parts[1] + '/index.html';
    return request;
  }

  // 5. Deeper extension-less path: keep the uppercased UID, let the origin
  //    resolve it (will 403/404 if absent).
  request.uri = uri;
  return request;
}
