import m0000 from './20260930165314_init/migration.sql';
import m0001 from './20260930180548_sender_color/migration.sql';
import m0002 from './20261001163359_payments/migration.sql';

  export default {
    migrations: {
      "20260930165314_init": m0000,
"20260930180548_sender_color": m0001,
"20261001163359_payments": m0002
}
  }
  