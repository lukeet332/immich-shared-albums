/** web/query.rs — reading and writing query strings, in one place. See ARCHITECTURE.md. */
/// `application/x-www-form-urlencoded` decoding, which is what a query string is: `+` means a space
/// and `%XX` is a byte. Bytes are collected first and decoded as UTF-8 at the end, so a multi-byte
/// character split across escapes survives.
///
/// A malformed escape is left ALONE rather than dropped or turned into a replacement character: a
/// share key is an opaque token compared for equality, and silently rewriting it would make a wrong
/// key look like a right one.
pub fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&value[i + 1..i + 3], 16) {
                Ok(byte) => {
                    out.push(byte);
                    i += 3;
                }
                Err(_) => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The unreserved set from RFC 3986; everything else becomes uppercase `%XX`. Uppercase because a
/// share key travels in a URL a person may copy, and two encodings of one key must compare equal.
pub fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// One parameter's decoded value, or `None` when the query does not carry it.
pub fn param(query: Option<&str>, name: &str) -> Option<String> {
    for pair in query?.split('&') {
        // A bare flag (`?native`) has no `=`, so it never matches a named parameter.
        if let Some((key, value)) = pair.split_once('=') {
            if key == name {
                return Some(percent_decode(value));
            }
        }
    }
    None
}

/// Whether the URI's query carries a parameter with this name — including as a bare flag
/// (`?native`), which has no value at all. The name is compared DECODED, so an encoded spelling of
/// the same name matches and a marker cannot be hidden by percent-escapes.
pub fn query_has(uri: &axum::http::Uri, name: &str) -> bool {
    let Some(query) = uri.query() else {
        return false;
    };
    query.split('&').any(|pair| {
        let (key, _) = pair.split_once('=').unwrap_or((pair, ""));
        percent_decode(key) == name
    })
}

/// The query string with one parameter name removed, every other pair kept in order. The name is
/// matched DECODED, matching `query_has`: a marker that counts as ours must also be stripped as
/// ours, or Immich would receive the very parameter we just decided to answer on. Only OUR marker
/// is ever dropped.
pub fn stripped_query(uri: &axum::http::Uri, drop_name: &str) -> String {
    uri.query()
        .map(|q| {
            q.split('&')
                .filter(|pair| {
                    let (key, _) = pair.split_once('=').unwrap_or((pair, ""));
                    percent_decode(key) != drop_name
                })
                .collect::<Vec<_>>()
                .join("&")
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoding_handles_escapes_spaces_and_nonsense() {
        assert_eq!(percent_decode("abc"), "abc");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(
            percent_decode("%E2%82%AC"),
            "€",
            "a multi-byte character survives"
        );
        // A malformed escape is left as written, not dropped: a share key is compared for equality.
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn encoding_leaves_the_unreserved_set_alone() {
        assert_eq!(urlencode("aZ0-_.~"), "aZ0-_.~");
        assert_eq!(urlencode("a/b"), "a%2Fb");
        assert_eq!(urlencode(" "), "%20", "a space is an escape, never a +");
    }

    #[test]
    fn a_parameter_is_found_whatever_else_is_in_the_query() {
        assert_eq!(param(Some("key=abc"), "key"), Some("abc".into()));
        assert_eq!(
            param(Some("size=preview&key=a%2Fb"), "key"),
            Some("a/b".into())
        );
        assert_eq!(param(Some("nope=1"), "key"), None);
        assert_eq!(param(None, "key"), None);
        // `key` must match the WHOLE name: `monkey=` is not a share key.
        assert_eq!(param(Some("monkey=1"), "key"), None);
    }

    #[test]
    fn a_round_trip_returns_the_original() {
        let key = "a/b+c d%é";
        assert_eq!(percent_decode(&urlencode(key)), key);
    }

    fn uri_with(query: &str) -> axum::http::Uri {
        axum::http::Uri::builder()
            .path_and_query(format!("/x?{query}"))
            .build()
            .unwrap()
    }

    #[test]
    fn a_marker_is_found_whatever_its_value_form() {
        assert!(query_has(&uri_with("native=1"), "native"));
        // A bare flag (`?native`) has no `=`, and it still carries the marker.
        assert!(query_has(&uri_with("a=1&native"), "native"));
        // The name is compared DECODED: `?n%61tive=1` is `native=1` on the wire, and an encoded
        // spelling must not make the marker invisible.
        assert!(query_has(&uri_with("n%61tive=1"), "native"));
        assert!(
            !query_has(&uri_with("nativeness=1"), "native"),
            "the whole name matches"
        );
        assert!(!query_has(&uri_with("a=1&b=2"), "native"));
        assert!(!query_has(&uri_with(""), "native"));
    }

    #[test]
    fn stripping_drops_one_marker_and_keeps_the_rest_in_order() {
        assert_eq!(stripped_query(&uri_with("native=1"), "native"), "");
        assert_eq!(
            stripped_query(&uri_with("a=1&native=1&b=2"), "native"),
            "a=1&b=2"
        );
        assert_eq!(stripped_query(&uri_with("a=1"), "native"), "a=1");
        assert_eq!(stripped_query(&uri_with(""), "native"), "");
        // Same contract as `query_has`: a marker that counts as ours is stripped as ours, so the
        // passthrough never forwards the parameter this side just decided to answer on.
        assert_eq!(
            stripped_query(&uri_with("a=1&n%61tive=1&b=2"), "native"),
            "a=1&b=2"
        );
    }
}
