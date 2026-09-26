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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoding_handles_escapes_spaces_and_nonsense() {
        assert_eq!(percent_decode("abc"), "abc");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("%E2%82%AC"), "€", "a multi-byte character survives");
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
        assert_eq!(param(Some("size=preview&key=a%2Fb"), "key"), Some("a/b".into()));
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
}
