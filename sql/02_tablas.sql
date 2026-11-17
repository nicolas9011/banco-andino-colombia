-- Modelo de dominio de Banco Andino Colombia.
-- Dinero: NUMERIC. Instantes: TIMESTAMPTZ. Solo datos sinteticos.

CREATE SEQUENCE nucleo.seq_numero_cuenta START 1;

CREATE TABLE nucleo.oficina (
    id            bigserial PRIMARY KEY,
    codigo        text        NOT NULL UNIQUE,
    nombre        text        NOT NULL CHECK (length(btrim(nombre)) > 0),
    departamento  text        NOT NULL,
    ciudad        text        NOT NULL,
    estado        text        NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'inactiva')),
    creado_en     timestamptz NOT NULL DEFAULT now()
);

-- Los limites del producto son en COP; las cuentas USD los reciben divididos por 4000.
CREATE TABLE nucleo.producto (
    id                           bigserial PRIMARY KEY,
    codigo                       text          NOT NULL UNIQUE,
    nombre                       text          NOT NULL,
    tipo                         text          NOT NULL CHECK (tipo IN ('ahorro', 'corriente', 'nomina', 'adicional')),
    permite_sobregiro            boolean       NOT NULL DEFAULT false,
    sobregiro_maximo             numeric(18,2) NOT NULL DEFAULT 0 CHECK (sobregiro_maximo >= 0 AND sobregiro_maximo <> 'NaN'),
    limite_retiro_diario         numeric(18,2) NOT NULL CHECK (limite_retiro_diario > 0 AND limite_retiro_diario <> 'NaN'),
    limite_transferencia_diaria  numeric(18,2) NOT NULL CHECK (limite_transferencia_diaria > 0 AND limite_transferencia_diaria <> 'NaN'),
    activo                       boolean       NOT NULL DEFAULT true,
    CONSTRAINT producto_sobregiro_coherente CHECK (permite_sobregiro OR sobregiro_maximo = 0)
);

CREATE TABLE nucleo.cliente (
    id                 bigserial PRIMARY KEY,
    tipo_persona       text        NOT NULL DEFAULT 'natural' CHECK (tipo_persona IN ('natural', 'juridica')),
    tipo_documento     text        NOT NULL DEFAULT 'CC' CHECK (tipo_documento IN ('CC', 'CE', 'TI', 'PAS', 'NIT', 'SIS')),
    documento          text        NOT NULL UNIQUE,
    nombre             text        NOT NULL CHECK (length(btrim(nombre)) > 0),
    correo             text        UNIQUE,
    telefono           text,
    departamento       text,
    ciudad             text,
    direccion          text,
    estado             text        NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'inactivo', 'bloqueado')),
    fecha_vinculacion  date        NOT NULL DEFAULT current_date,
    creado_en          timestamptz NOT NULL DEFAULT now(),
    -- Una persona juridica se identifica con NIT y solo ella.
    CONSTRAINT cliente_documento_coherente CHECK (
        tipo_documento = 'SIS' OR ((tipo_persona = 'juridica') = (tipo_documento = 'NIT'))),
    -- La ubicacion es un dato obligatorio del cliente (el cliente tecnico SISTEMA no tiene).
    -- COALESCE: un CHECK que evalua a NULL PASA, asi que NULL debe contarse como vacio.
    CONSTRAINT cliente_ubicacion_obligatoria CHECK (
        tipo_documento = 'SIS'
        OR (COALESCE(length(btrim(departamento)), 0) > 0 AND COALESCE(length(btrim(ciudad)), 0) > 0))
);

CREATE TABLE nucleo.cuenta (
    id                           bigserial PRIMARY KEY,
    cliente_id                   bigint        NOT NULL REFERENCES nucleo.cliente (id),
    producto_id                  bigint        REFERENCES nucleo.producto (id),
    oficina_id                   bigint        REFERENCES nucleo.oficina (id),
    numero                       text          NOT NULL UNIQUE,
    moneda                       char(3)       NOT NULL CHECK (moneda IN ('COP', 'USD')),
    tipo                         text          NOT NULL DEFAULT 'cliente' CHECK (tipo IN ('cliente', 'sistema')),
    tipo_titularidad             text          NOT NULL DEFAULT 'individual'
                                 CHECK (tipo_titularidad IN ('individual', 'conjunta', 'empresarial')),
    estado                       text          NOT NULL DEFAULT 'pendiente'
                                 CHECK (estado IN ('pendiente', 'activa', 'bloqueada', 'cerrada')),
    -- saldo = saldo contable. Disponible = saldo + sobregiro_autorizado (ver api.v_saldos).
    saldo                        numeric(18,2) NOT NULL DEFAULT 0 CHECK (saldo <> 'NaN'),
    sobregiro_autorizado         numeric(18,2) NOT NULL DEFAULT 0 CHECK (sobregiro_autorizado >= 0 AND sobregiro_autorizado <> 'NaN'),
    limite_retiro_diario         numeric(18,2) CHECK (limite_retiro_diario > 0 AND limite_retiro_diario <> 'NaN'),
    limite_transferencia_diaria  numeric(18,2) CHECK (limite_transferencia_diaria > 0 AND limite_transferencia_diaria <> 'NaN'),
    fecha_apertura               date          NOT NULL DEFAULT current_date,
    creado_en                    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT cuenta_saldo_minimo CHECK (tipo = 'sistema' OR saldo >= -sobregiro_autorizado),
    CONSTRAINT cuenta_cliente_completa CHECK (
        tipo = 'sistema' OR (producto_id IS NOT NULL AND oficina_id IS NOT NULL
                             AND limite_retiro_diario IS NOT NULL AND limite_transferencia_diaria IS NOT NULL))
);

CREATE TABLE nucleo.cuenta_titular (
    cuenta_id   bigint      NOT NULL REFERENCES nucleo.cuenta (id),
    cliente_id  bigint      NOT NULL REFERENCES nucleo.cliente (id),
    rol         text        NOT NULL CHECK (rol IN ('titular', 'cotitular')),
    creado_en   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cuenta_id, cliente_id)
);

-- Eventos administrativos de la cuenta. NO son movimientos financieros.
CREATE TABLE nucleo.evento_cuenta (
    id                bigserial PRIMARY KEY,
    cuenta_id         bigint      NOT NULL REFERENCES nucleo.cuenta (id),
    tipo              text        NOT NULL CHECK (tipo IN
                      ('creacion', 'activacion', 'bloqueo', 'desbloqueo', 'cambio_limites', 'cierre')),
    motivo            text,
    actor_usuario_id  bigint,
    datos             jsonb,
    creado_en         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nucleo.transaccion (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    clave_idempotencia  text          NOT NULL UNIQUE,
    tipo                text          NOT NULL CHECK (tipo IN
                        ('deposito', 'retiro', 'transferencia', 'debito', 'credito', 'ajuste', 'reverso')),
    -- Solo se persisten transacciones contabilizadas; las rechazadas se revierten completas.
    estado              text          NOT NULL DEFAULT 'POSTED' CHECK (estado = 'POSTED'),
    monto               numeric(18,2) NOT NULL CHECK (monto > 0 AND monto <> 'NaN'),
    cuenta_debito       bigint        NOT NULL REFERENCES nucleo.cuenta (id),
    cuenta_credito      bigint        NOT NULL REFERENCES nucleo.cuenta (id),
    canal               text          NOT NULL DEFAULT 'sistema' CHECK (canal IN ('web', 'cajero', 'atm', 'brebe', 'sistema')),
    concepto            text          CHECK (length(concepto) <= 200),
    actor_usuario_id    bigint,       -- FK a seguridad.usuario en 09_rbac.sql
    ip                  inet,
    reversa_de          uuid          UNIQUE REFERENCES nucleo.transaccion (id),
    creado_en           timestamptz   NOT NULL DEFAULT now(),
    CHECK (cuenta_debito <> cuenta_credito),
    CHECK ((tipo = 'reverso') = (reversa_de IS NOT NULL))
);

CREATE TABLE nucleo.movimiento (
    id               bigserial PRIMARY KEY,
    transaccion_id   uuid          NOT NULL REFERENCES nucleo.transaccion (id),
    cuenta_id        bigint        NOT NULL REFERENCES nucleo.cuenta (id),
    sentido          char(1)       NOT NULL CHECK (sentido IN ('D', 'C')),
    monto            numeric(18,2) NOT NULL CHECK (monto > 0 AND monto <> 'NaN'),
    saldo_posterior  numeric(18,2) NOT NULL CHECK (saldo_posterior <> 'NaN'),
    creado_en        timestamptz   NOT NULL DEFAULT now()
);

-- Tarjeta debito para el ATM. Numero y PIN solo existen como hash.
CREATE TABLE nucleo.tarjeta (
    id                  bigserial PRIMARY KEY,
    cuenta_id           bigint      NOT NULL REFERENCES nucleo.cuenta (id),
    numero_hash         text        NOT NULL UNIQUE,
    ultimos4            char(4)     NOT NULL CHECK (ultimos4 ~ '^[0-9]{4}$'),
    pin_hash            text        NOT NULL,
    estado              text        NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'bloqueada', 'vencida', 'cancelada')),
    intentos_fallidos   integer     NOT NULL DEFAULT 0 CHECK (intentos_fallidos >= 0),
    vence               date        NOT NULL,
    creado_en           timestamptz NOT NULL DEFAULT now()
);

-- Bre-B ACADEMICO: llaves y envios simulados. No hay integracion con la red real.
CREATE TABLE nucleo.llave_brebe (
    id          bigserial PRIMARY KEY,
    cliente_id  bigint      NOT NULL REFERENCES nucleo.cliente (id),
    cuenta_id   bigint      NOT NULL REFERENCES nucleo.cuenta (id),
    tipo        text        NOT NULL CHECK (tipo IN ('celular', 'correo', 'documento', 'alfanumerica')),
    valor       text        NOT NULL CHECK (length(valor) BETWEEN 3 AND 80),
    estado      text        NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'inactiva')),
    creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_llave_brebe_activa ON nucleo.llave_brebe (valor) WHERE estado = 'activa';

CREATE TABLE nucleo.brebe_operacion (
    transaccion_id    uuid    PRIMARY KEY REFERENCES nucleo.transaccion (id),
    llave_destino_id  bigint  NOT NULL REFERENCES nucleo.llave_brebe (id),
    es_simulacion     boolean NOT NULL DEFAULT true CHECK (es_simulacion)
);

-- Restricciones de integridad (no de rendimiento) que la revision ECC echo en falta:
-- una cuenta tiene UN titular principal, UNA caja del sistema por moneda y UNA tarjeta activa.
CREATE UNIQUE INDEX uq_titular_principal       ON nucleo.cuenta_titular (cuenta_id) WHERE rol = 'titular';
CREATE UNIQUE INDEX uq_caja_por_moneda         ON nucleo.cuenta (moneda) WHERE tipo = 'sistema';
CREATE UNIQUE INDEX uq_tarjeta_activa_cuenta   ON nucleo.tarjeta (cuenta_id) WHERE estado = 'activa';
