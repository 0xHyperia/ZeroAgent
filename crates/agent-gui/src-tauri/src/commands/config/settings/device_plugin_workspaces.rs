pub(crate) fn device_plugin_workspace_paths() -> Result<Vec<PathBuf>, String> {
    let db = open_db()?;
    let system = load_system_with_defaults(&db, &default_project_workdir()?)?;
    let unavailable: HashSet<_> = [
        SYSTEM_HIDDEN_WORKSPACE_PROJECT_PATHS_KEY,
        SYSTEM_MISSING_WORKSPACE_PROJECT_PATHS_KEY,
        SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY,
    ]
    .into_iter()
    .filter_map(|key| system.get(key).and_then(Value::as_array))
    .flatten()
    .filter_map(Value::as_str)
    .map(normalize_project_path_key)
    .collect();
    Ok(system
        .get(SYSTEM_WORKSPACE_PROJECTS_KEY)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|project| {
            matches!(
                project.get("kind").and_then(Value::as_str),
                Some("managed" | "folder")
            )
        })
        .filter_map(|project| project.get("path").and_then(Value::as_str))
        .filter(|path| !unavailable.contains(&normalize_project_path_key(path)))
        .map(PathBuf::from)
        .collect())
}
