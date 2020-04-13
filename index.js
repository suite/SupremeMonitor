const fs = require("fs");
const rp = require("request-promise");
const { Webhook, MessageBuilder } = require("discord-webhook-node");
const { Signale } = require("signale");
const config = require("./config");
const newLine = require("os").EOL;

class SupremeMonitor {
  constructor(config) {
    this.config = config;
    this.loadedProducts = {};
    this.logger = new Signale({
      interactive: false,
      scope: "SupremeMonitor"
    });
    this.logger.config({
      displayTimestamp: true
    });
    this.hook = new Webhook(this.config.discord["webhook"]);

    this.headers = {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      Host: "www.supremenewyork.com",
      Pragma: "no-cache",
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 8.0.0; Pixel 2 XL Build/OPD1.170816.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://www.supremenewyork.com"
    };
  }

  async fetchProducts() {
    await this.checkWeek();

    this.logger.info("Loading products...");
    this.loadedProducts = {};

    const opts = {
      url: "https://www.supremenewyork.com/shop.json",
      method: "GET",
      headers: this.headers,
      agentOptions: { secureProtocol: "TLSv1_2_method" },
      gzip: true,
      json: true
    };

    if (this.config.proxies["useProxies"]) opts["proxy"] = this.getProxy();

    try {
      let resp = await rp(opts);
      resp = resp["products_and_categories"];

      let stockTasks = [];
      for (let category of Object.keys(resp)) {
        for (let product of resp[category]) {
          stockTasks.push(this.fetchStock(product));
        }
      }

      let stockData = await Promise.all(stockTasks);

      for (let stockObj of stockData) {
        this.loadedProducts[stockObj["product"]["id"]] = { stockObj };
      }

      this.logger.success("Loaded products!");

      return this.startMonitor();
    } catch (err) {
      this.logger.fatal(`Error loading products: ${err.message}`);
      await this.sleep(this.config.errorDelay);
      return await this.fetchProducts();
    }
  }

  async fetchStock(product, productStyles) {
    let prodId = productStyles ? product : product["id"];

    const opts = {
      url: `https://www.supremenewyork.com/shop/${prodId}.json`,
      method: "GET",
      headers: this.headers,
      gzip: true,
      agentOptions: { secureProtocol: "TLSv1_2_method" },
      json: true,
      proxy: this.getProxy()
    };

    if (this.config.proxies["useProxies"]) opts["proxy"] = this.getProxy();

    try {
      const resp = await rp(opts);

      //Load in size and styles...
      if (!productStyles) {
        let stockObj = { product, styles: [] };
        for (let style of resp["styles"]) {
          stockObj["styles"].push(style);
        }
        return stockObj;
      } else {
        let restocked = false;
        for (let j = 0; j < resp["styles"].length; j++) {
          for (let i = 0; i < resp["styles"][j]["sizes"].length; i++) {
            let oldStock = this.loadedProducts[prodId]["stockObj"]["styles"][j][
              "sizes"
            ][i]["stock_level"];
            let newStock = resp["styles"][j]["sizes"][i]["stock_level"];

            if (oldStock != newStock && newStock === 1) {
              restocked = true;

              let { name, image_url_hi } = this.loadedProducts[prodId][
                "stockObj"
              ]["product"];

              this.logger.success("Restock!: ", name);

              this.sendWebhook(
                name,
                `https://www.supremenewyork.com/shop/${prodId}`,
                resp["styles"][j]["name"],
                resp["styles"][j]["sizes"][i]["name"],
                `https:${image_url_hi}`
              );
            }
          }
        }

        return restocked;
      }
    } catch (err) {
      if (err.message === `404 - {"status":"404","error":"Not Found"}`) {
        let isNewWeek = await this.checkWeek();
        if (isNewWeek) {
          this.logger.info("New week detected. Loading new products...");
          return true;
        }
      }
      this.logger.fatal(`Error fetching stock: ${err.message}`);
      await this.sleep(this.config.errorDelay);
      return await this.fetchStock(product, productStyles);
    }
  }

  async startMonitor() {
    this.logger.info("Monitoring...");
    while (true) {
      try {
        let isRestock = false;

        let restockTasks = [];
        for (let id of Object.keys(this.loadedProducts)) {
          restockTasks.push(this.fetchStock(id, true));
        }

        let restockData = await Promise.all(restockTasks);

        for (let data of restockData) {
          if (data) {
            isRestock = true;
            break;
          }
        }

        if (isRestock) {
          this.logger.info(
            `Waiting Restock Delay... ${this.config.restockDelay}ms`
          );
          await this.sleep(this.config.restockDelay);
          return this.fetchProducts();
        }

        this.logger.info(
          `Waiting Monitor Delay... ${this.config.monitorDelay}ms`
        );
        await this.sleep(this.config.monitorDelay);
      } catch (err) {
        this.logger.fatal(new Error(`Error running monitor: ${err.message}`));
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getProxy() {
    if (!this.config.proxies["useProxies"]) return null;

    if (!this.proxies) {
      this.proxies = fs
        .readFileSync(this.config.proxies["proxyFile"], "utf8")
        .split(newLine);
    }

    return this.formatProxy(
      this.proxies[Math.floor(Math.random() * this.proxies.length)]
    );
  }

  formatProxy(proxy) {
    if (proxy && ["localhost", ""].indexOf(proxy) < 0) {
      proxy = proxy.replace(" ", "_");
      const proxySplit = proxy.split(":");
      if (proxySplit.length > 3)
        return (
          "http://" +
          proxySplit[2] +
          ":" +
          proxySplit[3] +
          "@" +
          proxySplit[0] +
          ":" +
          proxySplit[1]
        );
      else return "http://" + proxySplit[0] + ":" + proxySplit[1];
    } else return undefined;
  }

  sendWebhook(name, url, color, size, image) {
    const embed = new MessageBuilder()
      .setTitle(name)
      .setURL(url)
      .addField("Color", color, true)
      .addField("Size", size, true)
      .setColor(this.config.discord["webhookColor"])
      .setThumbnail(image)
      .setFooter(this.config.discord["webhookFooter"])
      .setTimestamp();

    this.hook.send(embed);
  }

  async checkWeek() {
    const opts = {
      url: "https://www.supremenewyork.com/shop.json",
      method: "GET",
      headers: this.headers,
      agentOptions: { secureProtocol: "TLSv1_2_method" },
      gzip: true,
      json: true
    };

    if (this.config.proxies["useProxies"]) opts["proxy"] = this.getProxy();

    try {
      let resp = await rp(opts);
      let week = resp["release_week"];

      if (!this.releaseWeek) {
        this.releaseWeek = week;
        this.logger.info(`Loaded week: ${this.releaseWeek}`);
        return false;
      } else {
        if (this.releaseWeek != week) {
          return true;
        } else {
          return false;
        }
      }
    } catch (err) {
      this.logger.fatal(`Error checking week: ${err.message}`);
      await this.sleep(this.config.errorDelay);
      return await this.checkWeek();
    }
  }
}

(() => {
  console.log(`
          ____          __  ___          _ __          
          / ____ _____  /  |/  ___  ___  (_/ /____  ____
         _\\ \\/ // / _ \\/ /|_/ / _ \\/ _ \\/ / __/ _ \\/ __/
        /___/\\_,_/ .__/_/  /_/\\___/_//_/_/\\__/\\___/_/   
                  /_/                                     
        `);

  console.log(`Config:\n${JSON.stringify(config, null, 4)}`);

  new SupremeMonitor(config).fetchProducts();
})();
