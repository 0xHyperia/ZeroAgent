package auth

import "testing"

func TestLocalBearerRequiresExactlyOneNonemptyCredential(t *testing.T) {
	for _, test := range []struct {
		header, expected string
		valid            bool
	}{
		{"Bearer opaque", "opaque", true}, {"bearer opaque", "opaque", true},
		{"opaque", "opaque", false}, {"Basic opaque", "opaque", false},
		{"Bearer opaque another", "opaque", false}, {"Bearer", "", false},
		{"Bearer opaque", "other", false}, {"Bearer opaque", "", false},
	} {
		if got := ValidateBearerHeader(test.header, test.expected); got != test.valid {
			t.Errorf("bearer acceptance mismatch: got %v, want %v", got, test.valid)
		}
	}
}
