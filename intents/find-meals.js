const moment = require("moment-timezone");
const DialogActions = require("./lib/dialog-actions");
const Location = require("./lib/location");
const DataLoader = require("./lib/data-loader");
const MealFinder = require("./lib/meal-finder");
const parseTime = require("./lib/getTime");
let location;
let meals;
let mealCounter = 0;
let mealFinder;
let meal;
let closestMeals;

class LocationFinder {
  constructor(event) {
    this.event = event;
    this.slots = event.currentIntent.slots;
  }

  async getLocation() {
    const location =
      (await this.getKnownLocation()) ||
      (await this.getLocationFromGps()) ||
      (await this.getLocationFromSlots());

    return location;
  }

  async getKnownLocation() {
    if (!this.slots.Latitude || !this.slots.Longitude) return null;

    try {
      return await Location.fromCoords({
        latitude: this.slots.Latitude,
        longitude: this.slots.Longitude
      });
    } catch (error) {
      return null;
    }
  }

  async getLocationFromGps() {
    //if (this.slots.useGPS === "No") return;
    try {
      if (this.event.sessionAttributes.userPosition == null) return;
    } catch (error) {}

    try {
      const parsedLocation = JSON.parse(
        this.event.sessionAttributes.userPosition
      );
      return await Location.fromCoords(parsedLocation);
    } catch (error) {
      return false;
    }
  }

  async getLocationFromSlots() {
    if (
      this.slots.Intersection === undefined ||
      this.slots.Intersection === null
    )
      return null;

    try {
      return await Location.fromAddress(this.slots.Intersection + " Toronto");
    } catch (error) {
      return null;
    }
  }
}

class TimeParser {
  constructor(event) {
    this.event = event;
    this.slots = event.currentIntent.slots;
  }

  getTime() {
    if (this.slots.mealNow === "Now") {
      this.slots.Date = moment()
        .tz("America/New_York")
        .format("YYYY-MM-DD");
      this.slots.Time = moment()
        .tz("America/New_York")
        .format("HH:mm");
    }
  }
}

class Validator {
  constructor(event) {
    this.event = event;
    this.slots = event.currentIntent.slots;
    this.sessionAttributes = event.sessionAttributes;

    // if (this.event.inputTranscript === "Yes, allow GPS Location") {
    //   this.slots.useGPS = "Yes";
    // } else if (this.event.inputTranscript === "No, don't allow GPS Location") {
    //   this.slots.useGPS = "No";
    // }
  }

  async validate() {
    if (this.slots.mealNow == null) {
      return DialogActions.buttonElicitSlot(
        this.event.sessionAttributes,
        "mealNow",
        this.event.currentIntent.name,
        this.slots,
        "Are you looking for meals now?",
        "now or later?",
        ["Yes, it's for now.", "No, it's for a later time."],
        ["Now", "Later"]
      );
    }

    if (this.slots.Eligibility == null) {
      return DialogActions.buttonElicitSlot(
        this.event.sessionAttributes,
        "Eligibility",
        this.event.currentIntent.name,
        this.slots,
        "Before we find a meal for you, you can answer a few more questions that might help us find a better option for you, based on your identity. Would you like to answer a few questions?",
        "Feel free to skip any questions you don’t feel comfortable answering.",
        ["Yes", "No"],
        ["Yes", "No"]
      );
    }

    if (
      this.slots.Eligibility === "Yes" &&
      this.slots.Age == null &&
      this.slots.Gender == null
    ) {
      return DialogActions.elicitSlot(
        this.event.sessionAttributes,
        "Age",
        this.event.currentIntent.name,
        this.slots,
        "How old are you?"
      );
    } else if (
      this.slots.Eligibility === "Yes" &&
      this.slots.Age != null &&
      this.slots.Gender == null
    ) {
      return DialogActions.buttonElicitSlot(
        this.event.sessionAttributes,
        "Gender",
        this.event.currentIntent.name,
        this.slots,
        "What is your gender?",
        "Feel free to skip any questions you don’t feel comfortable answering.",
        ["Male", "Female", "Trans", "LGBT", "Skip"],
        ["male", "female", "trans", "LGBT", "mix"]
      );
    }

    const location = await new LocationFinder(this.event).getLocation();
    const time = new TimeParser(this.event).getTime();

    if (this.slots.Date == null) {
      return DialogActions.delegate(this.slots);
    }

    if (this.slots.Time == null) {
      this.slots.Time = parseTime.getTime(this.event.inputTranscript).miliTime;
    }

    if (this.slots.Time == null) {
      return DialogActions.delegate(this.slots);
    }

    return this.validateLocation(location);
  }

  validateLocation(location) {
    if (location == null) {
      if (this.slots.mealNow === "Now") {
        return DialogActions.delegate(this.slots);
      } else {
        return DialogActions.elicitSlot(
          this.sessionAttributes,
          "Intersection",
          this.event.currentIntent.name,
          this.slots,
          "Where will you be at that time?"
        );
      }
    }

    if (location.isUnknown()) {
      return DialogActions.fulfill(
        "I am sorry, I do not know where that is. Is it in Toronto?"
      );
    }

    if (location.isOutsideToronto()) {
      return DialogActions.fail(
        "Sorry, we are only serving Toronto at the moment."
      );
    }

    if (
      this.event.currentIntent.confirmationStatus === "None" &&
      this.slots.Confirmed !== "true"
    ) {
      return DialogActions.confirmAddress(
        { ...this.slots },
        this.event.sessionAttributes,
        this.event.currentIntent.name,
        location.address
      );
    } else if (
      this.event.currentIntent.confirmationStatus === "Denied" &&
      this.slots.Confirmed !== "true"
    ) {
      return DialogActions.elicitSlot(
        this.event.sessionAttributes,
        "Intersection",
        this.event.currentIntent.name,
        { ...this.slots },
        "Oops, I’m sorry about that! Can you tell me where you are? You can share an address, intersection, or landmark."
      );
    } else {
      this.slots.Confirmed = "true";
      return DialogActions.delegate({
        ...this.slots,
        Latitude: location.latitude,
        Longitude: location.longitude,
        Intersection: location.address
      });
    }
  }
}

exports.validations = async (event, context, callback) => {
  try {
    const validator = new Validator(event);
    let response = await validator.validate();
    callback(null, response);
  } catch (err) {
    callback(err);
  }
};

function formatMeals(closestMeals) {
  const mealString = closestMeals
    .map(meal => `${meal.organizationName}`)
    .join("\n");

  return mealString;
}

exports.fulfillment = async (event, context, callback) => {
  location = await new LocationFinder(event).getLocation();
  meals = await DataLoader.meals();
  mealFinder = new MealFinder(
    meals,
    location,
    event.currentIntent.slots.Time,
    event.currentIntent.slots.Age,
    event.currentIntent.slots.Gender
  );
  closestMeals = await mealFinder.find();
  if (closestMeals.length === 0) {
    callback(
      null,
      DialogActions.fulfill("There are no meals available with in an hour.")
    );
  } else {
    //const formattedMeals = formatMeals(closestMeals);

    if (event.currentIntent.slots.ShowMore === "More") {
      mealCounter++;
    }

    meal = closestMeals[mealCounter];

    if (meal == null) {
      return DialogActions.fulfill("That's all meals I could find");
    }
    mealString =
      `The meal closest to you is ${meal.organizationName} at ${
        meal.address
      }.` +
      ` The meal ${meal.startsInText(
        event.currentIntent.slots.mealNow === "Now" ? true : false
      )}, and it’s a ${meal.walkTimeText()} walk from where you are.` +
      ` If you like to, dial ${
        meal.phonenumber
      } to inquire about today's menu.`;

    //callback(null, DialogActions.fulfill(mealString));

    if (event.currentIntent.slots.ShowMore !== "Good") {
      return DialogActions.buttonElicitSlot(
        event.sessionAttributes,
        "ShowMore",
        event.currentIntent.name,
        event.currentIntent.slots,
        mealString,
        "Would you like to see other options?",
        ["Yes Please!", "No thanks, I like this one!"],
        ["More", "Good"]
      );
    } else if (event.currentIntent.slots.ShowMore === "Good") {
      callback(null, DialogActions.fulfill("Perfect!"));
    }
  }
};
