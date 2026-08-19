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
//   3. exactly /<uid>              -> 301 redirect to /<uid>/ so that relative
//                                     links inside the page resolve against
//                                     /<uid>/ and not against the site root.
//   4. last segment has a "."      -> concrete asset (e.g. /UID/assets/x.png),
//                                     pass through with only the UID uppercased.
//   5. exactly /<uid>/             -> rewrite to /<uid>/index.html.
//   6. anything else               -> pass through with the UID uppercased.
//      (this is how the generated slug redirects at /<uid>/<slug> are served)
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

  // 3. Normalize the canonical share URL to a directory URL. Serving
  //    index.html for /<uid> by internal rewrite leaves the browser's address
  //    at /<uid>, where a relative href like "assets/x.css" or a generated
  //    gallery's "page-slug" resolves against "/" and 404s. Redirecting first
  //    makes /<uid>/ the document base, so relative links work.
  //    Preserve the query string; CloudFront Functions expose it separately.
  if (parts.length === 2) {
    var qs = '';
    for (var name in request.querystring) {
      qs += (qs ? '&' : '?') + name;
      if (request.querystring[name].value) {
        qs += '=' + request.querystring[name].value;
      }
    }
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: '/' + parts[1] + '/' + qs } },
    };
  }

  // 4. A file extension in the last segment means it's a real asset request.
  var lastSlash = uri.lastIndexOf('/');
  var lastSegment = uri.substring(lastSlash + 1);
  if (lastSegment.indexOf('.') !== -1) {
    request.uri = uri;
    return request;
  }

  // 5. Exactly /<uid>/ (length 3 with an empty tail).
  if (parts.length === 3 && parts[2] === '') {
    request.uri = '/' + parts[1] + '/index.html';
    return request;
  }

  // 6. Deeper extension-less path: keep the uppercased UID, let the origin
  //    resolve it (will 403/404 if absent). Generated slug redirect stubs live
  //    here — they are real objects at /<uid>/<slug> with a text/html type.
  request.uri = uri;
  return request;
}
