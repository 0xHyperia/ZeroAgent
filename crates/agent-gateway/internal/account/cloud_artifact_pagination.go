package account

type CloudArtifactPage struct {
	Versions   []CloudArtifactVersion `json:"versions"`
	NextCursor string                 `json:"next_cursor"`
}

func cloudArtifactListScope(userID int64, conversationID, familyID, before string, limit int) (string, string, string, error) {
	if userID <= 0 || limit < 1 || limit > 100 {
		return "", "", "", ErrCloudArtifactInvalid
	}
	ids := []*string{&conversationID, &familyID, &before}
	for _, value := range ids {
		if *value == "" {
			continue
		}
		canonical, err := canonicalCloudFileID(*value)
		if err != nil {
			return "", "", "", ErrCloudArtifactInvalid
		}
		*value = canonical
	}
	return conversationID, familyID, before, nil
}

func cloudArtifactPage(versions []CloudArtifactVersion, limit int) *CloudArtifactPage {
	page := &CloudArtifactPage{Versions: versions}
	if len(page.Versions) > limit {
		page.Versions = page.Versions[:limit]
		page.NextCursor = page.Versions[len(page.Versions)-1].ID
	}
	return page
}
