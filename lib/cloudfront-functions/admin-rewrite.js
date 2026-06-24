// CloudFront viewer-request function for the admin page behaviors:
//   /login  /admin  /upload
//
// Maps the clean admin paths to the static HTML keys stored under app/ in the
// assets bucket, e.g. /admin -> /app/admin.html. A trailing slash is tolerated.
// Anything unexpected falls through to the login page.
//
// This is deliberately separate from clean-url.js: admin paths must NOT be
// uppercased or rewritten to /index.html.
//
// Written in ES5 style for the CloudFront Functions runtime.
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Normalize a single trailing slash ("/admin/" -> "/admin").
  if (uri.length > 1 && uri.charAt(uri.length - 1) === '/') {
    uri = uri.substring(0, uri.length - 1);
  }

  if (uri === '/login') {
    request.uri = '/app/login.html';
  } else if (uri === '/admin') {
    request.uri = '/app/admin.html';
  } else if (uri === '/upload') {
    request.uri = '/app/upload.html';
  } else {
    request.uri = '/app/login.html';
  }

  return request;
}
