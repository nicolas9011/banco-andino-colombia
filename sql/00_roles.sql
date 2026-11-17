DO $$
DECLARE
    r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['rol_lab_app', 'rol_lab_lectura', 'rol_lab_auditor']
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        END IF;
    END LOOP;
END
$$;
