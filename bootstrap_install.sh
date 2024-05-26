#!/bin/bash

if [[ "$EUID" -ne 0 ]]
  then echo "You must run this script as root to install a Fluxnode"
  exit
fi

# yarn is 80Mb, vs over 500Mb for npm.
apt-get install nodejs yarn -y

yarn install

node install.js CLEAN_INSTALL
