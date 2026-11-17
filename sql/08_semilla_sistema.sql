-- Datos de referencia (sinteticos). Los nombres de departamentos y ciudades omiten tildes a proposito.
INSERT INTO nucleo.oficina (codigo, nombre, departamento, ciudad) VALUES
    ('OF-BOG-01', 'Andino Chapinero',      'Bogota D.C.',        'Bogota'),
    ('OF-BOG-02', 'Andino Usaquen',        'Bogota D.C.',        'Bogota'),
    ('OF-MED-01', 'Andino El Poblado',     'Antioquia',          'Medellin'),
    ('OF-RNG-01', 'Andino Rionegro',       'Antioquia',          'Rionegro'),
    ('OF-CAL-01', 'Andino Granada',        'Valle del Cauca',    'Cali'),
    ('OF-PAL-01', 'Andino Palmira',        'Valle del Cauca',    'Palmira'),
    ('OF-SOA-01', 'Andino Soacha',         'Cundinamarca',       'Soacha'),
    ('OF-CHI-01', 'Andino Chia',           'Cundinamarca',       'Chia'),
    ('OF-BAQ-01', 'Andino Prado',          'Atlantico',          'Barranquilla'),
    ('OF-BGA-01', 'Andino Cabecera',       'Santander',          'Bucaramanga'),
    ('OF-CTG-01', 'Andino Bocagrande',     'Bolivar',            'Cartagena'),
    ('OF-CUC-01', 'Andino Caobos',         'Norte de Santander', 'Cucuta'),
    ('OF-MTR-01', 'Andino Monteria',       'Cordoba',            'Monteria'),
    ('OF-IBG-01', 'Andino Ibague',         'Tolima',             'Ibague'),
    ('OF-PSO-01', 'Andino Pasto',          'Narino',             'Pasto'),
    ('OF-PPN-01', 'Andino Popayan',        'Cauca',              'Popayan'),
    ('OF-SMR-01', 'Andino Santa Marta',    'Magdalena',          'Santa Marta'),
    ('OF-TUN-01', 'Andino Tunja',          'Boyaca',             'Tunja'),
    ('OF-VVC-01', 'Andino Villavicencio',  'Meta',               'Villavicencio'),
    ('OF-NVA-01', 'Andino Neiva',          'Huila',              'Neiva'),
    ('OF-PEI-01', 'Andino Pereira',        'Risaralda',          'Pereira'),
    ('OF-MZL-01', 'Andino Manizales',      'Caldas',             'Manizales'),
    ('OF-VUP-01', 'Andino Valledupar',     'Cesar',              'Valledupar'),
    ('OF-RCH-01', 'Andino Riohacha',       'La Guajira',         'Riohacha'),
    ('OF-SIN-01', 'Andino Sincelejo',      'Sucre',              'Sincelejo'),
    ('OF-AXM-01', 'Andino Armenia',        'Quindio',            'Armenia');

INSERT INTO nucleo.producto (codigo, nombre, tipo, permite_sobregiro, sobregiro_maximo,
                             limite_retiro_diario, limite_transferencia_diaria) VALUES
    ('AHO-BASICA', 'Ahorro Andino Basica',   'ahorro',    false,       0,  2000000,  5000000),
    ('CTE-EMPRE',  'Corriente Andino Plus',  'corriente', true,  1000000,  6000000, 20000000),
    ('NOM-01',     'Nomina Andino',          'nomina',    false,       0,  3000000, 10000000),
    ('ADI-JOVEN',  'Cuenta Andino Joven',    'adicional', false,       0,   800000,  2000000);

INSERT INTO nucleo.cliente (tipo_documento, documento, nombre)
VALUES ('SIS', 'SISTEMA', 'Tesoreria Banco Andino')
ON CONFLICT (documento) DO NOTHING;

INSERT INTO nucleo.cuenta (cliente_id, numero, moneda, tipo, estado)
SELECT id, 'CAJA-' || m, m, 'sistema', 'activa'
  FROM nucleo.cliente, unnest(ARRAY['COP', 'USD']) AS m
 WHERE documento = 'SISTEMA'
ON CONFLICT (numero) DO NOTHING;
