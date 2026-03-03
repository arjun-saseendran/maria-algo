import mongoose from "mongoose";

// Two separate connections — strategies never share a database
let trafficDB = null;
let condorDB   = null;

export const connectDatabases = async () => {
  const trafficUri = process.env.MONGO_URI_TRAFFIC;
  const condorUri  = process.env.MONGO_URI_CONDOR;

  if (!trafficUri || !condorUri) {
    console.error("❌ DB Error: MONGO_URI_TRAFFIC or MONGO_URI_CONDOR missing in .env");
    process.exit(1);
  }

  try {
    // Traffic Light → primary mongoose connection
    await mongoose.connect(trafficUri);
    trafficDB = mongoose.connection;
    console.log(`✅ Traffic Light DB: ${mongoose.connection.name}`);

    // Iron Condor → secondary connection
    condorDB = await mongoose.createConnection(condorUri).asPromise();
    console.log(`✅ Iron Condor DB:   ${condorDB.name}`);
  } catch (err) {
    console.error("❌ DB Connection Error:", err.message);
    process.exit(1);
  }

  mongoose.connection.on("disconnected", () =>
    console.warn("⚠️  Traffic Light DB disconnected!")
  );
  mongoose.connection.on("error", (err) =>
    console.error("❌ Traffic Light DB error:", err.message)
  );
};

export const getCondorDB  = () => condorDB;
export const getTrafficDB = () => trafficDB;
