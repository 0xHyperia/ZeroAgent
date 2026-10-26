package auth

import "net/http"

// ImagePrincipal must come from verified deployment identity, never request
// scope headers or the shared Gateway management token. The current bearer
// middleware does not establish this identity.
type ImagePrincipal struct {
	OwnerID  string
	Backends map[string]ImageGrant
}

type ImageGrant struct {
	Execute   bool
	Configure bool
}

// ImagePrincipalResolver authenticates the user and loads server-side backend
// grants. A nil resolver deliberately disables Image Studio on shared targets.
type ImagePrincipalResolver func(*http.Request) (ImagePrincipal, error)
