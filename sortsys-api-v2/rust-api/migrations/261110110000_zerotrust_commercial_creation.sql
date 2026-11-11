-- Independent, authority-certified creation grants for projects and commercial cases.
ALTER TABLE __zerotrust_creation_capabilities
  ADD COLUMN namespace TEXT NOT NULL DEFAULT 'project'
    CHECK (namespace IN ('project','commercial')),
  ADD CONSTRAINT zerotrust_creation_namespace_binding
    CHECK (capability->>'namespace' IS NOT NULL AND capability->>'namespace'=namespace),
  DROP CONSTRAINT __zerotrust_creation_capabilities_pkey,
  ADD PRIMARY KEY (user_id,namespace);
